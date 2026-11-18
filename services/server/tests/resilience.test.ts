import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CircuitBreaker,
  CircuitOpenError,
  decorrelatedJitterDelay,
  LegacyHttpError,
  RetryBudget,
} from "../src/resilience.ts";
import { LegacyClient } from "../src/legacy.ts";
import { MemoryStore } from "../src/store.ts";
import { tick } from "../src/worker.ts";

const sampleInput = {
  sourceAccount: "INS000000001",
  targetAccount: "EMP000000001",
  amountMinor: 25_000,
  currency: "ZAR" as const,
};

test("circuit breaker opens after 5 consecutive 5xx failures, fast-fails for 30s, then probes half-open", async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  let shouldFail = true;

  const client = new LegacyClient("http://legacy.test", "bridge-key", "ops-key", {
    circuitBreaker: new CircuitBreaker({
      failureThreshold: 5,
      halfOpenAfterMs: 30_000,
      now: () => now,
    }),
    retry: {
      maxAttempts: 1,
      sleep: async () => {},
    },
    fetch: async () => {
      calls++;
      if (shouldFail) {
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
      });
    },
  });

  // 5 consecutive 503 failures trip the circuit breaker
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => client.lookup(randomUUID()), LegacyHttpError);
  }
  assert.equal(calls, 5);
  assert.equal(client.breaker.state, "OPEN");

  // During 30s cooldown, calls fast-fail with CircuitOpenError without invoking fetch
  now += 29_999;
  await assert.rejects(() => client.lookup(randomUUID()), CircuitOpenError);
  assert.equal(calls, 5, "Open circuit must not send network requests");

  // At 30s, breaker moves to HALF_OPEN and permits a probe
  now += 1;
  assert.equal(client.breaker.state, "HALF_OPEN");
  // If probe fails, breaker re-opens for another 30s
  await assert.rejects(() => client.lookup(randomUUID()), LegacyHttpError);
  assert.equal(calls, 6);
  assert.equal(client.breaker.state, "OPEN");

  // After another 30s, a successful probe closes the breaker
  now += 30_000;
  shouldFail = false;
  const result = await client.lookup(randomUUID());
  assert.equal(result, undefined);
  assert.equal(calls, 7);
  assert.equal(client.breaker.state, "CLOSED");
  assert.equal(client.breaker.failures, 0);
});

test("decorrelated jitter retries transient 5xx and respects capped retry budget", async () => {
  const delays: number[] = [];
  let calls = 0;
  const budget = new RetryBudget({
    windowMs: 60_000,
    minRetriesPerWindow: 2,
    maxRetriesPerWindow: 2,
    maxRetryRatio: 0.2,
  });

  const client = new LegacyClient("http://legacy.test", "bridge-key", undefined, {
    circuitBreaker: new CircuitBreaker({ failureThreshold: 20 }),
    retry: {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 500,
      budget,
      random: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ error: "boom" }), { status: 502 });
    },
  });

  // First call consumes the entire retry budget of 2 retries (1 initial + 2 retries = 3 calls)
  await assert.rejects(() => client.lookup(randomUUID()), LegacyHttpError);
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
  assert.equal(delays[0], decorrelatedJitterDelay(100, 100, 500, () => 0.5));
  assert.equal(
    delays[1],
    decorrelatedJitterDelay(delays[0], 100, 500, () => 0.5),
  );
  assert.ok(delays.every((d) => d >= 100 && d <= 500));

  // Second call gets 0 retries because the retry budget is exhausted
  await assert.rejects(() => client.lookup(randomUUID()), LegacyHttpError);
  assert.equal(calls, 4);
});

test("non-transient 4xx errors never retry and never trip the circuit breaker", async () => {
  let calls = 0;
  const client = new LegacyClient("http://legacy.test", "bridge-key", undefined, {
    circuitBreaker: new CircuitBreaker({ failureThreshold: 2 }),
    retry: { maxAttempts: 4, sleep: async () => {} },
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ error: "bad payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  for (let i = 0; i < 4; i++) {
    await assert.rejects(
      () => client.lookup(randomUUID()),
      (err: unknown) =>
        err instanceof LegacyHttpError &&
        err.status === 400 &&
        err.transient === false,
    );
  }
  assert.equal(calls, 4, "Each 400 must make exactly 1 attempt with 0 retries");
  assert.equal(client.breaker.state, "CLOSED");
  assert.equal(client.breaker.failures, 0);
});

test("per-attempt timeout aborts stalled legacy requests", async () => {
  const client = new LegacyClient("http://legacy.test", "bridge-key", undefined, {
    timeouts: { lookup: 30, submit: 50 },
    retry: { maxAttempts: 1, sleep: async () => {} },
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal!.reason ?? new Error("aborted"));
        });
      }),
  });

  await assert.rejects(() => client.lookup(randomUUID()));
  assert.equal(client.breaker.failures, 1);
});

test("worker dead-letters domain invariants and non-transient 4xx immediately, but retries transient/circuit-open errors", async () => {
  const store = new MemoryStore();

  // 1. Non-transient 400 from legacy -> immediate DEAD_LETTER / NEEDS_REVIEW
  const a1 = await store.create("INSURER_DEMO", randomUUID(), sampleInput);
  const badClient = new LegacyClient("http://legacy.test", "k", undefined, {
    retry: { maxAttempts: 3, sleep: async () => {} },
    fetch: async () =>
      new Response(JSON.stringify({ error: "bad" }), { status: 400 }),
  });
  await tick(store, badClient);
  assert.equal((await store.get(a1.id))!.status, "NEEDS_REVIEW");
  assert.equal((await store.get(a1.id))!.reason, "LEGACY_HTTP_400");
  assert.equal(store.outbox.get(a1.id)!.status, "DEAD_LETTER");
  assert.equal(store.outbox.get(a1.id)!.failures, 0);

  // 2. INVALID_LEGACY_STATUS -> immediate DEAD_LETTER / NEEDS_REVIEW
  const a2 = await store.create("INSURER_DEMO", randomUUID(), sampleInput);
  const invalidStatusClient = new LegacyClient("http://legacy.test", "k", undefined, {
    retry: { maxAttempts: 3, sleep: async () => {} },
    fetch: async () =>
      new Response(
        JSON.stringify({
          reference: a2.id,
          sourceAccount: a2.sourceAccount,
          targetAccount: a2.targetAccount,
          amountMinor: a2.amountMinor,
          currency: a2.currency,
          status: "POSTED",
          reason: "OK",
          postingId: null, // Violates POSTED postingId invariant
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  await tick(store, invalidStatusClient);
  assert.equal((await store.get(a2.id))!.status, "NEEDS_REVIEW");
  assert.equal((await store.get(a2.id))!.reason, "INVALID_LEGACY_STATUS");
  assert.equal(store.outbox.get(a2.id)!.status, "DEAD_LETTER");

  // 3. Transient 503 -> retries (VERIFYING + PENDING outbox), NOT dead-lettered on first attempt
  const a3 = await store.create("INSURER_DEMO", randomUUID(), sampleInput);
  const offlineClient = new LegacyClient("http://legacy.test", "k", undefined, {
    retry: { maxAttempts: 1, sleep: async () => {} },
    fetch: async () => new Response("down", { status: 503 }),
  });
  await tick(store, offlineClient);
  assert.equal((await store.get(a3.id))!.status, "VERIFYING");
  assert.equal(store.outbox.get(a3.id)!.status, "PENDING");
  assert.equal(store.outbox.get(a3.id)!.failures, 1);
});
