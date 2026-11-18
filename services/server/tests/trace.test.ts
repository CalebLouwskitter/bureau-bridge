import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createChildTraceparent,
  extractOrCreateTraceparent,
  generateTraceparent,
  parseTraceparent,
} from "../src/trace.ts";
import { makeApp } from "../src/app.ts";
import { issue } from "../src/auth.ts";
import { MemoryStore } from "../src/store.ts";
import { tick } from "../src/worker.ts";
import { LegacyClient, type Legacy } from "../src/legacy.ts";

test("W3C traceparent parser validates format and rejects invalid or zero IDs", () => {
  const valid = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const parsed = parseTraceparent(valid);
  assert.ok(parsed);
  assert.equal(parsed.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(parsed.parentId, "00f067aa0ba902b7");
  assert.equal(parsed.traceFlags, "01");

  // Rejects version ff, zero trace-id, zero parent-id, malformed strings
  assert.equal(
    parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    undefined,
  );
  assert.equal(
    parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`),
    undefined,
  );
  assert.equal(
    parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`),
    undefined,
  );
  assert.equal(parseTraceparent("not-a-traceparent"), undefined);

  // Child span preserves traceId & flags while rotating parentId
  const child = createChildTraceparent(valid);
  assert.equal(child.traceId, parsed.traceId);
  assert.equal(child.traceFlags, parsed.traceFlags);
  assert.notEqual(child.parentId, parsed.parentId);

  // Generated traceparent parses cleanly
  const gen = generateTraceparent();
  assert.deepEqual(parseTraceparent(gen.raw), gen);
  assert.equal(extractOrCreateTraceparent("invalid").traceId.length, 32);
});

test("end-to-end W3C traceparent propagates from Fastify -> Store -> Worker -> LegacyClient HTTP headers and logs", async () => {
  const incomingTrace =
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const store = new MemoryStore();
  const app = makeApp(store, {} as Legacy, {
    sessionSecret: "test-secret",
    demoPassword: "test-password",
  });
  const token = issue("insurer-admin", "test-secret")!;

  // 1. Incoming Fastify request captures and echoes W3C traceparent
  const res = await app.inject({
    method: "POST",
    url: "/allocations",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
      traceparent: incomingTrace,
    },
    payload: {
      sourceAccount: "INS000000001",
      targetAccount: "EMP000000001",
      amountMinor: 15_000,
      currency: "ZAR",
    },
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.headers["traceparent"], incomingTrace);
  const created = res.json();
  assert.equal(created.traceparent, incomingTrace);
  assert.equal(store.outbox.get(created.id)!.traceparent, incomingTrace);

  // 2. Request without traceparent generates a valid W3C traceparent
  const generatedRes = await app.inject({
    method: "GET",
    url: "/health",
  });
  assert.equal(generatedRes.statusCode, 200);
  assert.ok(parseTraceparent(generatedRes.headers["traceparent"] as string));

  // 3. Worker restores stored traceparent, creates child span, forwards to LegacyClient, and logs traceId
  const forwardedHeaders: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const legacy = new LegacyClient("http://legacy.test", "bridge-key", undefined, {
    retry: { maxAttempts: 1, sleep: async () => {} },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const tp = headers.get("traceparent");
      if (tp) forwardedHeaders.push(tp);
      const url = String(input);
      if (url.endsWith(`/v1/requests/${created.id}`)) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      }
      return new Response(
        JSON.stringify({
          reference: created.id,
          sourceAccount: created.sourceAccount,
          targetAccount: created.targetAccount,
          amountMinor: created.amountMinor,
          currency: created.currency,
          status: "RECEIVED",
          reason: null,
          postingId: null,
          traceparent: tp,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  await tick(store, legacy, (entry) => logs.push(entry));
  assert.equal(forwardedHeaders.length, 2);
  for (const tp of forwardedHeaders) {
    const parsed = parseTraceparent(tp);
    assert.ok(parsed);
    assert.equal(
      parsed.traceId,
      "4bf92f3577b34da6a3ce929d0e0e4736",
      "Forwarded child span must preserve originating traceId",
    );
    assert.notEqual(
      parsed.parentId,
      "00f067aa0ba902b7",
      "Downstream hop must rotate span parentId",
    );
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0].traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(logs[0].allocationId, created.id);

  await app.close();
});
