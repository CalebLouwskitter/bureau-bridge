import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "../src/store.ts";
import { tick } from "../src/worker.ts";
import { LegacyClient, type Legacy, type LegacyResult } from "../src/legacy.ts";

const sampleInput = {
  sourceAccount: "INS000000001",
  targetAccount: "EMP000000001",
  amountMinor: 25_000,
  currency: "ZAR" as const,
};

test("concurrent worker claims never double-claim the same queued allocation", async () => {
  const now = 1_700_000_000_000;
  const store = new MemoryStore(() => now);
  const a1 = await store.create("INSURER_DEMO", randomUUID(), sampleInput);
  const a2 = await store.create("INSURER_DEMO", randomUUID(), sampleInput);

  const claims = await Promise.all([
    store.claim(60),
    store.claim(60),
    store.claim(60),
    store.claim(60),
  ]);
  const claimed = claims.filter((j): j is NonNullable<typeof j> => Boolean(j));
  assert.equal(claimed.length, 2);
  assert.deepEqual(new Set(claimed.map((c) => c.id)), new Set([a1.id, a2.id]));
  assert.ok(claimed.every((c) => c.fencingToken === 1));
});

test("expired lease reclaim increments FencingToken and rejects stale worker transitions", async () => {
  let now = 1_700_000_000_000;
  const store = new MemoryStore(() => now);
  const a = await store.create("INSURER_DEMO", randomUUID(), sampleInput);

  const first = (await store.claim(30))!;
  assert.equal(first.id, a.id);
  assert.equal(first.fencingToken, 1);

  // Lease still active at +29s: second worker cannot claim
  now += 29_000;
  assert.equal(await store.claim(30), undefined);

  // Lease expired at +31s: second worker steals claim with monotonic token 2
  now += 2_000;
  const second = (await store.claim(30))!;
  assert.equal(second.id, a.id);
  assert.equal(second.fencingToken, 2);
  assert.notEqual(second.token, first.token);

  // Stale worker (token 1) cannot finish, retry, or dead-letter the row
  await store.finish(first, {
    status: "POSTED",
    reason: "STALE_WRITE",
    postingId: a.id,
  });
  await store.retry(first, "STALE_RETRY");
  await store.deadLetter(first, "STALE_DEAD_LETTER");
  assert.equal((await store.get(a.id))!.status, "QUEUED");
  assert.equal(store.outbox.get(a.id)!.status, "CLAIMED");
  assert.equal(store.outbox.get(a.id)!.fencingToken, 2);

  // Active worker (token 2) completes cleanly
  await store.finish(second, {
    status: "AWAITING_BATCH",
    reason: null,
    postingId: null,
  });
  assert.equal((await store.get(a.id))!.status, "AWAITING_BATCH");

  // Subsequent claim continues monotonic sequence (token 3)
  now += 4_000;
  const third = (await store.claim(30))!;
  assert.equal(third.fencingToken, 3);
});

test("worker forwards X-Fencing-Token to LegacyClient and legacy rejects stale tokens", async () => {
  let now = 1_700_000_000_000;
  const store = new MemoryStore(() => now);
  const a = await store.create("INSURER_DEMO", randomUUID(), sampleInput);

  const recordedTokens = new Map<string, number>();
  const receivedHeaders: Array<{ method: string; url: string; token?: string }> =
    [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const tokenHeader = req.headers["x-fencing-token"];
      const token =
        typeof tokenHeader === "string" ? Number(tokenHeader) : undefined;
      receivedHeaders.push({
        method: req.method ?? "GET",
        url: req.url ?? "",
        token: typeof tokenHeader === "string" ? tokenHeader : undefined,
      });
      if (req.method === "GET" && req.url?.startsWith("/v1/requests/")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request not found" }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/requests") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const existing = recordedTokens.get(body.reference) ?? 0;
        if (token !== undefined && token < existing) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Stale fencing token ${token}; recorded token is ${existing}`,
              code: "STALE_FENCING_TOKEN",
            }),
          );
          return;
        }
        if (token !== undefined && token > existing) {
          recordedTokens.set(body.reference, token);
        }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            reference: body.reference,
            sourceAccount: body.sourceAccount,
            targetAccount: body.targetAccount,
            amountMinor: body.amountMinor,
            currency: body.currency,
            status: "RECEIVED",
            reason: null,
            postingId: null,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const legacy = new LegacyClient(`http://127.0.0.1:${port}`, "bridge-key");

    // Tick 1: worker claims token 1 and forwards X-Fencing-Token: 1
    assert.equal(await tick(store, legacy), true);
    assert.equal((await store.get(a.id))!.status, "AWAITING_BATCH");
    assert.equal(receivedHeaders[0].token, "1");
    assert.equal(receivedHeaders[1].token, "1");
    assert.equal(recordedTokens.get(a.id), 1);

    // Higher token 2 succeeds and advances recorded token
    await legacy.submit(a, { fencingToken: 2 });
    assert.equal(recordedTokens.get(a.id), 2);

    // Stale token 1 is rejected with 409
    await assert.rejects(() => legacy.submit(a, { fencingToken: 1 }), /409/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("worker passes fencingToken option to Legacy lookup and submit", async () => {
  const store = new MemoryStore();
  const a = await store.create("INSURER_DEMO", randomUUID(), sampleInput);
  const seen: Array<{ op: string; fencingToken?: number }> = [];
  const result: LegacyResult = {
    reference: a.id,
    sourceAccount: a.sourceAccount,
    targetAccount: a.targetAccount,
    amountMinor: a.amountMinor,
    currency: a.currency,
    status: "RECEIVED",
    reason: null,
    postingId: null,
  };
  const legacy: Legacy = {
    lookup: async (_id, opts) => {
      seen.push({ op: "lookup", fencingToken: opts?.fencingToken });
      return undefined;
    },
    submit: async (_a, opts) => {
      seen.push({ op: "submit", fencingToken: opts?.fencingToken });
      return result;
    },
    inquire: async () => ({}),
    retryUnposted: async () => ({}),
    accounts: async () => ({
      generation: "g",
      sequence: 0,
      observedAt: new Date().toISOString(),
      balances: [],
    }),
    inventory: async () => ({
      requests: [],
      batches: [],
      truncated: false,
      core: {
        records: [],
        balances: [],
        generation: "g",
        observedAt: new Date().toISOString(),
        truncated: false,
      },
    }),
  };
  await tick(store, legacy);
  assert.deepEqual(seen, [
    { op: "lookup", fencingToken: 1 },
    { op: "submit", fencingToken: 1 },
  ]);
});
