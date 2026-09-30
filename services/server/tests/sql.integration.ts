import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sql from "mssql";
import type { ReconciliationRun } from "@bureau/contracts";
import { connection, SqlStore, Conflict } from "../src/store.ts";
const pool = await connection().connect(),
  store = new SqlStore(pool);
const client = "TEST_" + randomUUID().slice(0, 8),
  key = randomUUID();
let id: string | undefined;
try {
  const input = {
    sourceAccount: "INS000000001",
    targetAccount: "EMP000000001",
    amountMinor: 25000,
    currency: "ZAR" as const,
  };
  const rows = await Promise.all([
    store.create(client, key, input),
    store.create(client, key, input),
  ]);
  id = rows[0].id;
  assert.equal(rows[1].id, id);
  await assert.rejects(
    () => store.create(client, key, { ...input, amountMinor: 25001 }),
    Conflict,
  );
  const count = await pool
    .request()
    .input("id", sql.Char(36), id)
    .query("SELECT COUNT(*) AS n FROM dbo.Outbox WHERE AllocationId=@id");
  assert.equal(count.recordset[0].n, 1);
  const jobs = await Promise.all([store.claim(), store.claim()]);
  assert.equal(
    jobs.filter(Boolean).length,
    1,
    "Run against a fresh database with worker stopped",
  );
  const first = jobs.find(Boolean)!;
  await pool
    .request()
    .input("id", sql.Char(36), id)
    .query(
      "UPDATE dbo.Outbox SET LeaseUntil=DATEADD(SECOND,-1,SYSUTCDATETIME()) WHERE AllocationId=@id",
    );
  const second = (await store.claim())!;
  assert.notEqual(first.token, second.token);
  await store.finish(first, {
    status: "POSTED",
    reason: "STALE",
    postingId: id,
  });
  assert.equal((await store.get(id))!.status, "QUEUED");
  await store.finish(second, {
    status: "AWAITING_BATCH",
    reason: null,
    postingId: null,
  });
  assert.equal((await store.get(id))!.status, "AWAITING_BATCH");
  await store.wake(id);
  const finalJob = (await store.claim())!;
  await store.finish(finalJob, {
    status: "POSTED",
    reason: "OK",
    postingId: id,
  });
  await store.wake(id);
  assert.equal(
    await store.claim(),
    undefined,
    "Final inquiry must not reopen a completed outbox item",
  );
  // Simulate an old queued job racing with a terminal projection.
  const staleToken = randomUUID();
  await pool
    .request()
    .input("id", sql.Char(36), id)
    .input("token", sql.Char(36), staleToken)
    .query(
      "UPDATE dbo.Outbox SET LeaseToken=@token,LeaseUntil=DATEADD(SECOND,60,SYSUTCDATETIME()),DueAt=SYSUTCDATETIME() WHERE AllocationId=@id",
    );
  await store.retry({ id, token: staleToken, failures: 0 }, "LEGACY_OFFLINE");
  assert.equal((await store.get(id))!.status, "POSTED");
  assert.equal((await store.get(id))!.postingId, id);
  const observedAt = new Date().toISOString();
  const snapshot = {
    generation: "gen-new",
    sequence: 1,
    observedAt,
    balances: [
      {
        account: "EMP000000001",
        amountMinor: 25000,
        currency: "ZAR" as const,
        kind: "EMPLOYEE" as const,
        state: "ACTIVE" as const,
      },
    ],
  };
  await store.syncAccounts(client, snapshot);
  await store.syncAccounts(client, {
    ...snapshot,
    generation: "gen-old",
    sequence: 0,
    observedAt,
    balances: [{ ...snapshot.balances[0], amountMinor: 0 }],
  });
  const accounts = await store.accounts(client, "EMP000000001");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].amountMinor, 25000);
  assert.equal(accounts[0].generation, "gen-new");
  const run: ReconciliationRun = {
    id: randomUUID(),
    clientId: client,
    createdAt: observedAt,
    generation: "gen-new",
    observedAt,
    modernCount: 1,
    intakeCount: 1,
    coreCount: 1,
    truncated: false,
    findings: [
      {
        severity: "WARN",
        code: "TEST",
        reference: id,
        details: "Integration check",
      },
    ],
  };
  await store.saveReconciliation(run);
  assert.equal(
    (await store.latestReconciliation(client))!.findings[0].details,
    "Integration check",
  );
  console.log(
    "PASS SQL atomic create, replay/conflict, lease fencing, immutable final status, stale account snapshot rejection, and persisted reconciliation.",
  );
} finally {
  if (id)
    await pool
      .request()
      .input("id", sql.Char(36), id)
      .query(
        "DELETE dbo.AllocationEvents WHERE AllocationId=@id; DELETE dbo.Outbox WHERE AllocationId=@id; DELETE dbo.Allocations WHERE Id=@id;",
      );
  await pool.request().input("client", sql.VarChar(30), client)
    .query(`DELETE f FROM dbo.ReconciliationFindings f
    JOIN dbo.ReconciliationRuns r ON r.Id=f.RunId WHERE r.ClientId=@client;
    DELETE dbo.ReconciliationRuns WHERE ClientId=@client;
    DELETE dbo.AccountProjections WHERE ClientId=@client;DELETE dbo.AccountSync WHERE ClientId=@client;`);
  await pool.close();
}
