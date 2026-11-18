import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Allocation, Status } from "@bureau/contracts";
import { makeApp } from "../src/app.ts";
import { issue } from "../src/auth.ts";
import {
  InvalidStateTransition,
  isValidAllocationTransition,
  MemoryStore,
} from "../src/store.ts";
import type { Legacy } from "../src/legacy.ts";

const dummyLegacy = {} as Legacy;
const payload = {
  sourceAccount: "INS000000001",
  targetAccount: "EMP000000001",
  amountMinor: 25_000,
  currency: "ZAR" as const,
};

test("IETF Idempotency-Key: concurrent duplicate returns 409 Conflict while first request is IN_PROGRESS", async () => {
  const store = new MemoryStore();
  let releaseCreate!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    const origCreate = store.create.bind(store);
    store.create = async (clientId, key, input) => {
      resolve();
      await new Promise<void>((done) => {
        releaseCreate = done;
      });
      return origCreate(clientId, key, input);
    };
  });

  const app = makeApp(store, dummyLegacy, {
    sessionSecret: "test-secret",
    demoPassword: "test-password",
  });
  const token = issue("insurer-admin", "test-secret")!;
  const key = randomUUID();

  // Kick off request 1 (holds IN_PROGRESS lock)
  const firstPromise = app.inject({
    method: "POST",
    url: "/allocations",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload,
  });

  await createStarted;

  // Request 2 arrives concurrently with same key + same payload -> 409 Conflict
  const concurrent = await app.inject({
    method: "POST",
    url: "/allocations",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload,
  });
  assert.equal(concurrent.statusCode, 409);
  assert.equal(concurrent.json().code, "IDEMPOTENCY_IN_PROGRESS");

  // Request 3 arrives concurrently with same key + DIFFERENT payload -> 422 Unprocessable Content
  const mismatchWhileInProgress = await app.inject({
    method: "POST",
    url: "/allocations",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload: { ...payload, amountMinor: 99_999 },
  });
  assert.equal(mismatchWhileInProgress.statusCode, 422);
  assert.equal(
    mismatchWhileInProgress.json().code,
    "IDEMPOTENCY_PAYLOAD_MISMATCH",
  );

  // Complete request 1 -> 202 Accepted
  releaseCreate();
  const first = await firstPromise;
  assert.equal(first.statusCode, 202);
  const created = first.json() as Allocation;

  // Replay after completion -> cached 202 and identical body with Idempotency-Replayed header
  const replay = await app.inject({
    method: "POST",
    url: "/allocations",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload,
  });
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.deepEqual(replay.json(), created);

  // Reuse key after completion with DIFFERENT payload -> 422 Unprocessable Content
  const mismatchAfter = await app.inject({
    method: "POST",
    url: "/allocations",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload: { ...payload, amountMinor: 25_001 },
  });
  assert.equal(mismatchAfter.statusCode, 422);
  assert.equal(mismatchAfter.json().code, "IDEMPOTENCY_PAYLOAD_MISMATCH");

  await app.close();
});

test("IETF Idempotency-Key: cached response replays for 24h TTL and expires after TTL", async () => {
  let now = 1_700_000_000_000;
  const store = new MemoryStore(() => now);
  const app = makeApp(store, dummyLegacy, {
    sessionSecret: "test-secret",
    demoPassword: "test-password",
    idempotencyTtlSeconds: 86_400,
  });
  const token = issue("insurer-admin", "test-secret")!;
  const key = randomUUID();

  const first = await app.inject({
    method: "POST",
    url: "/allocations",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload,
  });
  assert.equal(first.statusCode, 202);
  const firstId = first.json().id;

  // At 23h59m59s, still cached and replayed
  now += 86_399 * 1000;
  const cached = await app.inject({
    method: "POST",
    url: "/allocations",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload,
  });
  assert.equal(cached.statusCode, 202);
  assert.equal(cached.headers["idempotency-replayed"], "true");
  assert.equal(cached.json().id, firstId);

  // Advance past 24h TTL: cache entry expires (acquireIdempotency acquires fresh lock)
  now += 2_000;
  const afterExpiry = await store.acquireIdempotency(
    "INSURER_DEMO",
    key,
    "f".repeat(64),
    86_400,
  );
  assert.deepEqual(afterExpiry, { kind: "ACQUIRED" });

  await app.close();
});

test("IETF Idempotency-Key: IN_PROGRESS lock is released if creation fails", async () => {
  const store = new MemoryStore();
  let failNext = true;
  const origCreate = store.create.bind(store);
  store.create = async (clientId, key, input) => {
    if (failNext) {
      failNext = false;
      throw new Error("Transient DB error");
    }
    return origCreate(clientId, key, input);
  };

  const app = makeApp(store, dummyLegacy, {
    sessionSecret: "test-secret",
    demoPassword: "test-password",
  });
  const token = issue("insurer-admin", "test-secret")!;
  const key = randomUUID();

  const failed = await app.inject({
    method: "POST",
    url: "/allocations",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload,
  });
  assert.equal(failed.statusCode, 503);

  // Retrying the same key succeeds instead of staying stuck in 409 IN_PROGRESS
  const succeeded = await app.inject({
    method: "POST",
    url: "/allocations",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload,
  });
  assert.equal(succeeded.statusCode, 202);
  await app.close();
});

test("Allocation FSM enforces valid forward transitions and blocks regression of terminal POSTED/DECLINED states", async () => {
  // Valid happy path: QUEUED -> AWAITING_BATCH -> PROCESSING -> VERIFYING -> POSTED
  assert.equal(isValidAllocationTransition("QUEUED", "AWAITING_BATCH"), true);
  assert.equal(isValidAllocationTransition("AWAITING_BATCH", "PROCESSING"), true);
  assert.equal(isValidAllocationTransition("PROCESSING", "VERIFYING"), true);
  assert.equal(isValidAllocationTransition("VERIFYING", "POSTED"), true);
  assert.equal(isValidAllocationTransition("VERIFYING", "DECLINED"), true);

  // Backward regressions blocked
  assert.equal(isValidAllocationTransition("AWAITING_BATCH", "QUEUED"), false);
  assert.equal(isValidAllocationTransition("PROCESSING", "AWAITING_BATCH"), false);
  assert.equal(isValidAllocationTransition("PROCESSING", "QUEUED"), false);
  assert.equal(isValidAllocationTransition("VERIFYING", "QUEUED"), false);

  // Terminal states can NEVER transition to any other status
  const allStatuses: Status[] = [
    "QUEUED",
    "AWAITING_BATCH",
    "PROCESSING",
    "VERIFYING",
    "POSTED",
    "DECLINED",
    "NEEDS_REVIEW",
  ];
  for (const target of allStatuses) {
    if (target !== "POSTED") {
      assert.equal(isValidAllocationTransition("POSTED", target), false);
    }
    if (target !== "DECLINED") {
      assert.equal(isValidAllocationTransition("DECLINED", target), false);
    }
  }

  // Runtime enforcement in MemoryStore
  const store = new MemoryStore();
  const a = await store.create("INSURER_DEMO", randomUUID(), payload);
  store.transitionStatus(a.id, "AWAITING_BATCH", null, null);
  assert.throws(
    () => store.transitionStatus(a.id, "QUEUED", null, null),
    InvalidStateTransition,
  );
  store.transitionStatus(a.id, "PROCESSING", null, null);
  store.transitionStatus(a.id, "VERIFYING", null, null);
  store.transitionStatus(a.id, "POSTED", "OK", a.id);

  assert.throws(
    () => store.transitionStatus(a.id, "DECLINED", "BAD", null),
    InvalidStateTransition,
  );
  assert.throws(
    () => store.transitionStatus(a.id, "VERIFYING", "REGRESS", null),
    InvalidStateTransition,
  );
  assert.equal((await store.get(a.id))!.status, "POSTED");
});
