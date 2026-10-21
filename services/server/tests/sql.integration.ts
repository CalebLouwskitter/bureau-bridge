import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sql from "mssql";
import type { ReconciliationRun } from "@bureau/contracts";
import { BANK_DETAILS, SETTLEMENT_ACCOUNT } from "@bureau/contracts";
import { connection, Conflict } from "../src/store.ts";
import { SqlPayoutStore } from "../src/payout-store.ts";
import { generateFile, importResponse, submitFile } from "../src/payouts.ts";
import { BankSimulator, MemoryLedger } from "../src/bank-sim.ts";
import {
  buildResponse,
  parseEft,
  parseResponse,
  sha256,
  USER_CODE,
} from "../src/eft.ts";
const pool = await connection().connect(),
  store = new SqlPayoutStore(pool);
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
  await store.syncAccounts(client, {
    ...snapshot,
    generation: "gen-v3",
    sequence: 2,
    balances: [
      ...snapshot.balances,
      {
        account: SETTLEMENT_ACCOUNT,
        amountMinor: 0,
        currency: "ZAR",
        kind: "SETTLEMENT",
        state: "ACTIVE",
      },
    ],
  });
  assert.equal((await store.accounts(client)).length, 2);

  // Payments hub: atomic instructions, one file per payout, one answer per file.
  const payoutInput = {
    sourceAccount: "EMP000000001",
    targetAccount: SETTLEMENT_ACCOUNT,
    amountMinor: 10000,
    currency: "ZAR" as const,
  };
  const payoutKey = randomUUID();
  const [p1, p1Again] = await Promise.all([
    store.createPayout(client, payoutKey, payoutInput),
    store.createPayout(client, payoutKey, payoutInput),
  ]);
  assert.equal(p1Again.id, p1.id);
  assert.equal(p1.status, "AWAITING_DEBIT");
  await assert.rejects(
    () =>
      store.createPayout(client, payoutKey, {
        ...payoutInput,
        amountMinor: 10001,
      }),
    Conflict,
  );
  const p2 = await store.createPayout(client, randomUUID(), {
    ...payoutInput,
    sourceAccount: "EMP000000002",
  });
  assert.equal(
    await generateFile(store, client, randomUUID()),
    undefined,
    "A payout cannot be filed before its core debit posts",
  );
  await pool.request().input("client", sql.VarChar(30), client)
    .query(`UPDATE dbo.Allocations SET Status='POSTED',PostingId=Id WHERE ClientId=@client AND TargetAccount='${SETTLEMENT_ACCOUNT}';
      UPDATE o SET DueAt=NULL FROM dbo.Outbox o JOIN dbo.Allocations a ON a.Id=o.AllocationId WHERE a.ClientId=@client;`);
  const fileKey = randomUUID();
  const generated = await Promise.all([
    generateFile(store, client, fileKey),
    generateFile(store, client, fileKey),
  ]);
  assert.equal(generated[1]!.id, generated[0]!.id);
  assert.deepEqual(
    [
      generated[0]!.itemCount,
      generated[0]!.amountTotal,
      generated[0]!.generation,
    ],
    [2, 20000, 1],
  );
  assert.equal(
    await generateFile(store, client, randomUUID()),
    undefined,
    "A payout belongs to at most one file",
  );
  const stored = (await store.payoutFile(client, generated[0]!.id))!;
  assert.equal(sha256(stored.content), stored.sha256);
  assert.equal(parseEft(stored.content).items.length, 2);
  const two = BANK_DETAILS.EMP000000002;
  const bank = new BankSimulator(
    new MemoryLedger(),
    new Set([`${two.branch}/${two.account}`]),
  );
  const answered = await submitFile(store, bank, client, stored.id);
  assert.deepEqual(
    [answered.paid, answered.returned, answered.duplicate],
    [1, 1, false],
  );
  assert.equal(
    (await submitFile(store, bank, client, stored.id)).duplicate,
    true,
    "Reprocessing the bank answer must not create a second credit",
  );
  const listed = await store.listPayouts(client);
  assert.equal(listed.find((p) => p.id === p1.id)!.status, "PAID");
  const returned = listed.find((p) => p.id === p2.id)!;
  assert.equal(returned.status, "RETURN_PENDING");
  const credit = (await store.get(returned.returnAllocationId!))!;
  assert.deepEqual(
    [credit.sourceAccount, credit.targetAccount, credit.amountMinor],
    [SETTLEMENT_ACCOUNT, "EMP000000002", 10000],
  );
  const original = parseResponse(
    (await bank.inquire(USER_CODE, stored.generation))!,
  );
  await assert.rejects(
    () =>
      importResponse(
        store,
        client,
        buildResponse({
          ...original,
          results: original.results.map((r) => ({
            ...r,
            outcome: "PAID",
            code: null,
          })),
        }),
      ),
    Conflict,
  );
  const employeeView = await store.list(client, "EMP000000002");
  assert.deepEqual(
    new Set(employeeView.map((a) => a.id)),
    new Set([p2.id, credit.id]),
  );
  const scanned = await store.scanPayouts(client);
  assert.deepEqual(
    [scanned.payouts.length, scanned.files.length, scanned.truncated],
    [2, 1, false],
  );
  console.log(
    "PASS SQL atomic create, replay/conflict, lease fencing, immutable final status, stale account snapshot rejection, persisted reconciliation, idempotent payout instructions, one-file-per-payout generation, and once-only bank response processing.",
  );
} finally {
  await pool.request().input("client", sql.VarChar(30), client)
    .query(`DELETE dbo.PayoutInstructions WHERE ClientId=@client;
    DELETE b FROM dbo.BankResponses b JOIN dbo.PayoutFiles f ON f.Id=b.PayoutFileId WHERE f.ClientId=@client;
    DELETE dbo.PayoutFiles WHERE ClientId=@client;
    DELETE e FROM dbo.AllocationEvents e JOIN dbo.Allocations a ON a.Id=e.AllocationId WHERE a.ClientId=@client;
    DELETE o FROM dbo.Outbox o JOIN dbo.Allocations a ON a.Id=o.AllocationId WHERE a.ClientId=@client;
    DELETE dbo.Allocations WHERE ClientId=@client;`);
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
