import { randomUUID } from "node:crypto";
import sql from "mssql";
import type {
  Allocation,
  AllocationInput,
  Status,
  AccountProjection,
  AccountSnapshot,
  ReconciliationRun,
} from "@bureau/contracts";
import { env } from "./config.ts";
import {
  fingerprint as payloadFingerprint,
  payoutInstructionApprovalHash,
} from "./ids.ts";

export interface BankDetails {
  branch: string;
  account: string;
  holder: string;
}

export class Conflict extends Error {}
export class IdempotencyPayloadMismatch extends Conflict {}
export class IdempotencyInProgress extends Conflict {}
export class InvalidStateTransition extends Error {}

export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours

export const ALLOWED_ALLOCATION_TRANSITIONS: Readonly<
  Record<Status, readonly Status[]>
> = {
  QUEUED: [
    "AWAITING_BATCH",
    "PROCESSING",
    "VERIFYING",
    "POSTED",
    "DECLINED",
    "NEEDS_REVIEW",
  ],
  AWAITING_BATCH: [
    "PROCESSING",
    "VERIFYING",
    "POSTED",
    "DECLINED",
    "NEEDS_REVIEW",
  ],
  PROCESSING: ["VERIFYING", "POSTED", "DECLINED", "NEEDS_REVIEW"],
  VERIFYING: [
    "AWAITING_BATCH",
    "PROCESSING",
    "POSTED",
    "DECLINED",
    "NEEDS_REVIEW",
  ],
  NEEDS_REVIEW: [
    "AWAITING_BATCH",
    "PROCESSING",
    "VERIFYING",
    "POSTED",
    "DECLINED",
  ],
  POSTED: [],
  DECLINED: [],
};

export function isValidAllocationTransition(from: Status, to: Status): boolean {
  if (from === to) return true;
  return ALLOWED_ALLOCATION_TRANSITIONS[from].includes(to);
}

export type IdempotencyAcquireResult =
  | { kind: "ACQUIRED" }
  | { kind: "IN_PROGRESS" }
  | { kind: "MISMATCH" }
  | { kind: "REPLAY"; statusCode: number; body: unknown };

export interface IdempotencyRecordStore {
  acquireIdempotency(
    clientId: string,
    key: string,
    fingerprint: string,
    ttlSeconds?: number,
  ): Promise<IdempotencyAcquireResult>;
  completeIdempotency(
    clientId: string,
    key: string,
    statusCode: number,
    body: unknown,
    allocationId?: string,
  ): Promise<void>;
  releaseIdempotency(clientId: string, key: string): Promise<void>;
}

export interface Job {
  id: string;
  token: string;
  fencingToken: number;
  failures: number;
  traceparent?: string | null;
}
export interface Outcome {
  status: Status;
  reason: string | null;
  postingId: string | null;
}
export interface Store extends Partial<IdempotencyRecordStore> {
  create(
    clientId: string,
    key: string,
    input: AllocationInput,
    bank?: BankDetails,
    traceparent?: string | null,
  ): Promise<Allocation>;
  list(clientId: string, employee?: string): Promise<Allocation[]>;
  get(id: string): Promise<Allocation | undefined>;
  events(id: string): Promise<unknown[]>;
  claim(leaseSeconds?: number): Promise<Job | undefined>;
  finish(job: Job, outcome: Outcome): Promise<void>;
  retry(job: Job, reason: string): Promise<void>;
  deadLetter?(job: Job, reason: string): Promise<void>;
  wake(id: string): Promise<void>;
  accounts(clientId: string, employee?: string): Promise<AccountProjection[]>;
  syncAccounts(clientId: string, snapshot: AccountSnapshot): Promise<void>;
  scan(
    clientId: string,
  ): Promise<{ allocations: Allocation[]; truncated: boolean }>;
  saveReconciliation(run: ReconciliationRun): Promise<void>;
  latestReconciliation(
    clientId: string,
  ): Promise<ReconciliationRun | undefined>;
}
export function connection(
  database = env("MSSQL_DATABASE", "BureauBridge"),
  admin = false,
) {
  return new sql.ConnectionPool({
    server: env("MSSQL_HOST", "sqlserver"),
    port: Number(env("MSSQL_PORT", "1433")),
    user: admin ? "sa" : env("MSSQL_USER", "bureau_app"),
    password: env(admin ? "MSSQL_SA_PASSWORD" : "MSSQL_PASSWORD"),
    database,
    options: {
      encrypt: true,
      trustServerCertificate: env("MSSQL_TRUST_CERT", "false") === "true",
    },
    pool: { min: 0, max: 8 },
    connectionTimeout: 15000,
    requestTimeout: 15000,
  });
}
export function map(row: any): Allocation {
  return {
    id: row.Id,
    clientId: row.ClientId,
    sourceAccount: row.SourceAccount,
    targetAccount: row.TargetAccount,
    amountMinor: Number(row.AmountMinor),
    currency: row.Currency,
    status: row.Status,
    reason: row.Reason,
    postingId: row.PostingId,
    ...(row.Traceparent ? { traceparent: row.Traceparent } : {}),
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  };
}
export class SqlStore implements Store {
  constructor(readonly pool: sql.ConnectionPool) {}
  // With bank details, the payout instruction is created in the same
  // transaction as its core debit allocation and outbox row.
  async create(
    clientId: string,
    key: string,
    input: AllocationInput,
    bank?: BankDetails,
    traceparent?: string | null,
  ) {
    const fingerprint = payloadFingerprint(input);
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    const id = randomUUID();
    const approvalHash = bank
      ? payoutInstructionApprovalHash({
          id,
          amountMinor: input.amountMinor,
          branch: bank.branch,
          bankAccount: bank.account,
        })
      : null;
    try {
      await new sql.Request(tx)
        .input("id", sql.Char(36), id)
        .input("client", sql.VarChar(30), clientId)
        .input("key", sql.Char(36), key)
        .input("hash", sql.Char(64), fingerprint)
        .input("source", sql.Char(12), input.sourceAccount)
        .input("target", sql.Char(12), input.targetAccount)
        .input("amount", sql.BigInt, input.amountMinor)
        .input("branch", sql.Char(6), bank?.branch ?? null)
        .input("bankAccount", sql.Char(11), bank?.account ?? null)
        .input("holder", sql.VarChar(14), bank?.holder ?? null)
        .input("approvalHash", sql.Char(64), approvalHash)
        .input("traceparent", sql.VarChar(128), traceparent ?? null).query(`
          SET XACT_ABORT ON;
          INSERT dbo.Allocations (Id,ClientId,IdempotencyKey,Fingerprint,SourceAccount,TargetAccount,AmountMinor,Currency,Status,Traceparent)
          VALUES (@id,@client,@key,@hash,@source,@target,@amount,'ZAR','QUEUED',@traceparent);
          INSERT dbo.Outbox (AllocationId,Status,NextAttemptAtUtc,FencingToken,Traceparent) VALUES (@id,'PENDING',SYSUTCDATETIME(),0,@traceparent);
          INSERT dbo.AllocationEvents (AllocationId,Status,Traceparent) VALUES (@id,'QUEUED',@traceparent);
          IF @branch IS NOT NULL
            INSERT dbo.PayoutInstructions (Id,ClientId,EmployeeAccount,AmountMinor,Branch,BankAccount,Holder,ApprovalHash)
            VALUES (@id,@client,@source,@amount,@branch,@bankAccount,@holder,@approvalHash);`);
      await tx.commit();
      return (await this.get(id))!;
    } catch (error: any) {
      await tx.rollback().catch(() => {});
      if (![2601, 2627].includes(error.number)) throw error;
      const found = await this.pool
        .request()
        .input("client", sql.VarChar(30), clientId)
        .input("key", sql.Char(36), key)
        .query(
          "SELECT * FROM dbo.Allocations WHERE ClientId=@client AND IdempotencyKey=@key",
        );
      if (!found.recordset[0] || found.recordset[0].Fingerprint !== fingerprint)
        throw new IdempotencyPayloadMismatch(
          "Idempotency key reused with different data",
        );
      return map(found.recordset[0]);
    }
  }
  async acquireIdempotency(
    clientId: string,
    key: string,
    fingerprint: string,
    ttlSeconds = DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  ): Promise<IdempotencyAcquireResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.pool
          .request()
          .input("client", sql.VarChar(30), clientId)
          .input("key", sql.Char(36), key)
          .input("hash", sql.Char(64), fingerprint)
          .input("ttl", sql.Int, ttlSeconds).query(`
            SET XACT_ABORT ON;
            DELETE FROM dbo.IdempotencyKeys
              WHERE ClientId = @client AND IdempotencyKey = @key AND ExpiresAt <= SYSUTCDATETIME();
            INSERT dbo.IdempotencyKeys (ClientId, IdempotencyKey, Fingerprint, State, ExpiresAt)
            VALUES (@client, @key, @hash, 'IN_PROGRESS', DATEADD(SECOND, @ttl, SYSUTCDATETIME()));`);
        return { kind: "ACQUIRED" };
      } catch (error: any) {
        if (![2601, 2627].includes(error.number)) throw error;
        const found = await this.pool
          .request()
          .input("client", sql.VarChar(30), clientId)
          .input("key", sql.Char(36), key)
          .query(
            `SELECT Fingerprint, State, ResponseStatus, ResponseBody,
                    CASE WHEN ExpiresAt <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS Expired
             FROM dbo.IdempotencyKeys
             WHERE ClientId = @client AND IdempotencyKey = @key`,
          );
        const row = found.recordset[0];
        if (!row || row.Expired) continue;
        if (row.Fingerprint !== fingerprint) return { kind: "MISMATCH" };
        if (row.State === "IN_PROGRESS") return { kind: "IN_PROGRESS" };
        return {
          kind: "REPLAY",
          statusCode: Number(row.ResponseStatus),
          body: JSON.parse(row.ResponseBody),
        };
      }
    }
    return { kind: "IN_PROGRESS" };
  }
  async completeIdempotency(
    clientId: string,
    key: string,
    statusCode: number,
    body: unknown,
    allocationId?: string,
  ): Promise<void> {
    await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .input("key", sql.Char(36), key)
      .input("statusCode", sql.Int, statusCode)
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(body))
      .input("allocationId", sql.Char(36), allocationId ?? null).query(`
        UPDATE dbo.IdempotencyKeys
          SET State = 'COMPLETED',
              ResponseStatus = @statusCode,
              ResponseBody = @body,
              AllocationId = @allocationId,
              UpdatedAt = SYSUTCDATETIME()
          WHERE ClientId = @client AND IdempotencyKey = @key;`);
  }
  async releaseIdempotency(clientId: string, key: string): Promise<void> {
    await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .input("key", sql.Char(36), key)
      .query(
        "DELETE FROM dbo.IdempotencyKeys WHERE ClientId = @client AND IdempotencyKey = @key AND State = 'IN_PROGRESS'",
      );
  }
  async list(clientId: string, employee?: string) {
    const result = await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .input("employee", sql.Char(12), employee ?? null)
      .query(
        "SELECT TOP (100) * FROM dbo.Allocations WHERE ClientId=@client AND (@employee IS NULL OR TargetAccount=@employee OR SourceAccount=@employee) ORDER BY CreatedAt DESC",
      );
    return result.recordset.map(map);
  }
  async get(id: string) {
    const result = await this.pool
      .request()
      .input("id", sql.Char(36), id)
      .query("SELECT * FROM dbo.Allocations WHERE Id=@id");
    return result.recordset[0] ? map(result.recordset[0]) : undefined;
  }
  async events(id: string) {
    return (
      await this.pool
        .request()
        .input("id", sql.Char(36), id)
        .query(
          "SELECT Status AS status,Reason AS reason,CreatedAt AS createdAt FROM dbo.AllocationEvents WHERE AllocationId=@id ORDER BY Id",
        )
    ).recordset;
  }
  async claim(leaseSeconds = 60): Promise<Job | undefined> {
    const leaseToken = randomUUID();
    const result = await this.pool
      .request()
      .input("leaseToken", sql.Char(36), leaseToken)
      .input("leaseSeconds", sql.Int, leaseSeconds).query(`
      ;WITH due AS (
        SELECT TOP (1) *
        FROM dbo.Outbox WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE (Status = 'PENDING' AND NextAttemptAtUtc <= SYSUTCDATETIME())
           OR (Status = 'CLAIMED' AND LockedUntilUtc < SYSUTCDATETIME())
        ORDER BY NextAttemptAtUtc ASC, AllocationId ASC
      )
      UPDATE due
      SET Status = 'CLAIMED',
          LockedUntilUtc = DATEADD(SECOND, @leaseSeconds, SYSUTCDATETIME()),
          LeaseUntil = DATEADD(SECOND, @leaseSeconds, SYSUTCDATETIME()),
          LeaseToken = @leaseToken,
          FencingToken = FencingToken + 1
      OUTPUT inserted.AllocationId, inserted.FencingToken, inserted.LeaseToken, inserted.Failures, inserted.Traceparent;`);
    const row = result.recordset[0];
    return row
      ? {
          id: row.AllocationId,
          token: row.LeaseToken,
          fencingToken: Number(row.FencingToken),
          failures: row.Failures,
          traceparent: row.Traceparent ?? null,
        }
      : undefined;
  }
  async finish(job: Job, outcome: Outcome) {
    const terminal = ["POSTED", "DECLINED", "NEEDS_REVIEW"].includes(
      outcome.status,
    );
    await this.pool
      .request()
      .input("id", sql.Char(36), job.id)
      .input("fencingToken", sql.BigInt, job.fencingToken)
      .input("status", sql.VarChar(24), outcome.status)
      .input("reason", sql.VarChar(80), outcome.reason)
      .input("posting", sql.Char(36), outcome.postingId)
      .input("terminal", sql.Bit, terminal)
      .input("traceparent", sql.VarChar(128), job.traceparent ?? null).query(`
        SET XACT_ABORT ON; BEGIN TRAN;
        UPDATE dbo.Outbox
          SET Status = CASE WHEN @terminal = 1 THEN (CASE WHEN @status = 'NEEDS_REVIEW' THEN 'DEAD_LETTER' ELSE 'COMPLETED' END) ELSE 'PENDING' END,
              LockedUntilUtc = NULL,
              LeaseUntil = NULL,
              LeaseToken = NULL,
              Failures = 0,
              LastError = NULL,
              NextAttemptAtUtc = CASE WHEN @terminal = 1 THEN NULL ELSE DATEADD(SECOND, 3, SYSUTCDATETIME()) END,
              DueAt = CASE WHEN @terminal = 1 THEN NULL ELSE DATEADD(SECOND, 3, SYSUTCDATETIME()) END
          WHERE AllocationId = @id AND FencingToken = @fencingToken AND Status = 'CLAIMED';
        IF @@ROWCOUNT = 1 BEGIN
          IF EXISTS(SELECT 1 FROM dbo.Allocations WHERE Id = @id AND Status IN ('POSTED', 'DECLINED'))
            UPDATE dbo.Outbox SET Status = 'COMPLETED', NextAttemptAtUtc = NULL, DueAt = NULL WHERE AllocationId = @id;
          INSERT dbo.AllocationEvents (AllocationId, Status, Reason, Traceparent)
            SELECT Id, @status, @reason, COALESCE(@traceparent, Traceparent) FROM dbo.Allocations WHERE Id = @id AND Status <> @status AND Status NOT IN ('POSTED', 'DECLINED');
          UPDATE dbo.Allocations SET Status = @status, Reason = @reason, PostingId = @posting, UpdatedAt = SYSUTCDATETIME()
            WHERE Id = @id AND Status NOT IN ('POSTED', 'DECLINED');
        END; COMMIT;`);
  }
  async retry(job: Job, reason: string) {
    const failures = job.failures + 1;
    const status = failures >= 6 ? "NEEDS_REVIEW" : "VERIFYING";
    await this.pool
      .request()
      .input("id", sql.Char(36), job.id)
      .input("fencingToken", sql.BigInt, job.fencingToken)
      .input("failures", sql.Int, failures)
      .input("delay", sql.Int, Math.min(60, 2 ** failures))
      .input("status", sql.VarChar(24), status)
      .input("reason", sql.VarChar(80), reason.slice(0, 80))
      .input("traceparent", sql.VarChar(128), job.traceparent ?? null).query(`
        SET XACT_ABORT ON; BEGIN TRAN;
        UPDATE dbo.Outbox
          SET Failures = @failures,
              LastError = @reason,
              Status = CASE WHEN @failures >= 6 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
              LockedUntilUtc = NULL,
              LeaseUntil = NULL,
              LeaseToken = NULL,
              NextAttemptAtUtc = CASE WHEN @failures >= 6 THEN NULL ELSE DATEADD(SECOND, @delay, SYSUTCDATETIME()) END,
              DueAt = CASE WHEN @failures >= 6 THEN NULL ELSE DATEADD(SECOND, @delay, SYSUTCDATETIME()) END
          WHERE AllocationId = @id AND FencingToken = @fencingToken AND Status = 'CLAIMED';
        IF @@ROWCOUNT = 1 BEGIN
          IF EXISTS(SELECT 1 FROM dbo.Allocations WHERE Id = @id AND Status IN ('POSTED', 'DECLINED'))
            UPDATE dbo.Outbox SET Status = 'COMPLETED', NextAttemptAtUtc = NULL, DueAt = NULL WHERE AllocationId = @id;
          INSERT dbo.AllocationEvents (AllocationId, Status, Reason, Traceparent)
            SELECT Id, @status, @reason, COALESCE(@traceparent, Traceparent) FROM dbo.Allocations WHERE Id = @id AND Status <> @status AND Status NOT IN ('POSTED', 'DECLINED');
          UPDATE dbo.Allocations SET Status = @status, Reason = @reason, UpdatedAt = SYSUTCDATETIME()
            WHERE Id = @id AND Status NOT IN ('POSTED', 'DECLINED');
        END; COMMIT;`);
  }
  async deadLetter(job: Job, reason: string) {
    await this.pool
      .request()
      .input("id", sql.Char(36), job.id)
      .input("fencingToken", sql.BigInt, job.fencingToken)
      .input("reason", sql.VarChar(80), reason.slice(0, 80))
      .input("traceparent", sql.VarChar(128), job.traceparent ?? null).query(`
        SET XACT_ABORT ON; BEGIN TRAN;
        UPDATE dbo.Outbox
          SET LastError = @reason,
              Status = 'DEAD_LETTER',
              LockedUntilUtc = NULL,
              LeaseUntil = NULL,
              LeaseToken = NULL,
              NextAttemptAtUtc = NULL,
              DueAt = NULL
          WHERE AllocationId = @id AND FencingToken = @fencingToken AND Status = 'CLAIMED';
        IF @@ROWCOUNT = 1 BEGIN
          IF EXISTS(SELECT 1 FROM dbo.Allocations WHERE Id = @id AND Status IN ('POSTED', 'DECLINED'))
            UPDATE dbo.Outbox SET Status = 'COMPLETED' WHERE AllocationId = @id;
          INSERT dbo.AllocationEvents (AllocationId, Status, Reason, Traceparent)
            SELECT Id, 'NEEDS_REVIEW', @reason, COALESCE(@traceparent, Traceparent) FROM dbo.Allocations WHERE Id = @id AND Status <> 'NEEDS_REVIEW' AND Status NOT IN ('POSTED', 'DECLINED');
          UPDATE dbo.Allocations SET Status = 'NEEDS_REVIEW', Reason = @reason, UpdatedAt = SYSUTCDATETIME()
            WHERE Id = @id AND Status NOT IN ('POSTED', 'DECLINED');
        END; COMMIT;`);
  }
  async wake(id: string) {
    await this.pool.request().input("id", sql.Char(36), id)
      .query(`UPDATE o
        SET Status = 'PENDING',
            NextAttemptAtUtc = SYSUTCDATETIME(),
            DueAt = SYSUTCDATETIME(),
            LockedUntilUtc = NULL,
            LeaseUntil = NULL,
            LeaseToken = NULL,
            Failures = 0
        FROM dbo.Outbox o
        JOIN dbo.Allocations a ON a.Id = o.AllocationId
        WHERE o.AllocationId = @id AND a.Status NOT IN ('POSTED', 'DECLINED')
        AND (o.LockedUntilUtc IS NULL OR o.LockedUntilUtc < SYSUTCDATETIME());`);
  }
  async accounts(
    clientId: string,
    employee?: string,
  ): Promise<AccountProjection[]> {
    const result = await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .input("employee", sql.Char(12), employee ?? null)
      .query(`SELECT p.*,s.Generation,s.SourceSequence,s.ObservedAt
        FROM dbo.AccountProjections p JOIN dbo.AccountSync s ON s.ClientId=p.ClientId
        WHERE p.ClientId=@client AND (@employee IS NULL OR p.Account=@employee) ORDER BY p.Account`);
    return result.recordset.map((r: any) => ({
      account: r.Account,
      amountMinor: Number(r.AmountMinor),
      currency: r.Currency,
      kind: r.Kind,
      state: r.State,
      generation: r.Generation,
      sequence: Number(r.SourceSequence),
      observedAt: r.ObservedAt.toISOString(),
    }));
  }
  async syncAccounts(clientId: string, snapshot: AccountSnapshot) {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const params = () =>
        new sql.Request(tx)
          .input("client", sql.VarChar(30), clientId)
          .input("generation", sql.VarChar(64), snapshot.generation)
          .input("sequence", sql.BigInt, snapshot.sequence)
          .input("observed", sql.DateTime2, new Date(snapshot.observedAt));
      const current = await params().query(
        "SELECT Generation,SourceSequence,ObservedAt FROM dbo.AccountSync WITH (UPDLOCK,HOLDLOCK) WHERE ClientId=@client",
      );
      const row = current.recordset[0];
      if (
        row &&
        (Number(row.SourceSequence) > snapshot.sequence ||
          row.ObservedAt.getTime() > Date.parse(snapshot.observedAt) ||
          row.Generation === snapshot.generation)
      ) {
        await tx.commit();
        return;
      }
      await params()
        .query(`IF EXISTS(SELECT 1 FROM dbo.AccountSync WHERE ClientId=@client)
          UPDATE dbo.AccountSync SET Generation=@generation,SourceSequence=@sequence,ObservedAt=@observed WHERE ClientId=@client;
        ELSE INSERT dbo.AccountSync (ClientId,Generation,SourceSequence,ObservedAt) VALUES (@client,@generation,@sequence,@observed);
        DELETE dbo.AccountProjections WHERE ClientId=@client;`);
      await new sql.Request(tx)
        .input("client", sql.VarChar(30), clientId)
        .input(
          "items",
          sql.NVarChar(sql.MAX),
          JSON.stringify(snapshot.balances),
        ).query(`INSERT dbo.AccountProjections
          (ClientId,Account,AmountMinor,Currency,Kind,State) SELECT @client,account,amountMinor,currency,kind,state
          FROM OPENJSON(@items) WITH (account CHAR(12),amountMinor BIGINT,currency CHAR(3),kind VARCHAR(12),state VARCHAR(12));`);
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  }
  async scan(clientId: string) {
    const result = await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .query(
        "SELECT TOP (5001) * FROM dbo.Allocations WHERE ClientId=@client ORDER BY Id",
      );
    return {
      allocations: result.recordset.slice(0, 5000).map(map),
      truncated: result.recordset.length > 5000,
    };
  }
  async saveReconciliation(run: ReconciliationRun) {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input("id", sql.Char(36), run.id)
        .input("client", sql.VarChar(30), run.clientId)
        .input("created", sql.DateTime2, new Date(run.createdAt))
        .input("generation", sql.VarChar(64), run.generation)
        .input("observed", sql.DateTime2, new Date(run.observedAt))
        .input("modern", sql.Int, run.modernCount)
        .input("intake", sql.Int, run.intakeCount)
        .input("core", sql.Int, run.coreCount)
        .input("truncated", sql.Bit, run.truncated)
        .query(`INSERT dbo.ReconciliationRuns (Id,ClientId,CreatedAt,Generation,ObservedAt,ModernCount,IntakeCount,CoreCount,Truncated)
          VALUES (@id,@client,@created,@generation,@observed,@modern,@intake,@core,@truncated)`);
      await new sql.Request(tx)
        .input("id", sql.Char(36), run.id)
        .input("items", sql.NVarChar(sql.MAX), JSON.stringify(run.findings))
        .query(`INSERT dbo.ReconciliationFindings
          (RunId,Severity,Code,Category,Reference,Details) SELECT @id,severity,code,category,reference,details FROM OPENJSON(@items)
          WITH (severity VARCHAR(8),code VARCHAR(48),category VARCHAR(32),reference CHAR(36),details NVARCHAR(1000));`);
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  }
  async latestReconciliation(
    clientId: string,
  ): Promise<ReconciliationRun | undefined> {
    const result = await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .query(
        "SELECT TOP (1) * FROM dbo.ReconciliationRuns WHERE ClientId=@client ORDER BY CreatedAt DESC,Id DESC",
      );
    const r = result.recordset[0];
    if (!r) return undefined;
    const findings = await this.pool
      .request()
      .input("id", sql.Char(36), r.Id)
      .query(
        "SELECT Severity AS severity,Code AS code,Category AS category,Reference AS reference,Details AS details FROM dbo.ReconciliationFindings WHERE RunId=@id ORDER BY Id",
      );
    return {
      id: r.Id,
      clientId: r.ClientId,
      createdAt: r.CreatedAt.toISOString(),
      generation: r.Generation,
      observedAt: r.ObservedAt.toISOString(),
      modernCount: r.ModernCount,
      intakeCount: r.IntakeCount,
      coreCount: r.CoreCount,
      truncated: Boolean(r.Truncated),
      findings: findings.recordset.map((f: any) => ({
        severity: f.severity,
        code: f.code,
        ...(f.category ? { category: f.category } : {}),
        reference: f.reference,
        details: f.details,
      })),
    };
  }
}

export type OutboxState = "PENDING" | "CLAIMED" | "COMPLETED" | "DEAD_LETTER";

export interface MemoryOutboxRow {
  allocationId: string;
  status: OutboxState;
  nextAttemptAtUtc: number | null;
  lockedUntilUtc: number | null;
  leaseToken: string | null;
  fencingToken: number;
  failures: number;
  lastError: string | null;
  traceparent: string | null;
}

export class MemoryIdempotencyStore implements IdempotencyRecordStore {
  readonly records = new Map<
    string,
    {
      fingerprint: string;
      state: "IN_PROGRESS" | "COMPLETED";
      statusCode: number | null;
      body: string | null;
      allocationId: string | null;
      expiresAt: number;
    }
  >();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async acquireIdempotency(
    clientId: string,
    key: string,
    fingerprint: string,
    ttlSeconds = DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  ): Promise<IdempotencyAcquireResult> {
    const composite = `${clientId}:${key}`;
    const current = this.now();
    const existing = this.records.get(composite);
    if (existing && existing.expiresAt <= current) {
      this.records.delete(composite);
    }
    const active = this.records.get(composite);
    if (!active) {
      this.records.set(composite, {
        fingerprint,
        state: "IN_PROGRESS",
        statusCode: null,
        body: null,
        allocationId: null,
        expiresAt: current + ttlSeconds * 1000,
      });
      return { kind: "ACQUIRED" };
    }
    if (active.fingerprint !== fingerprint) return { kind: "MISMATCH" };
    if (active.state === "IN_PROGRESS") return { kind: "IN_PROGRESS" };
    return {
      kind: "REPLAY",
      statusCode: active.statusCode!,
      body: JSON.parse(active.body!),
    };
  }

  async completeIdempotency(
    clientId: string,
    key: string,
    statusCode: number,
    body: unknown,
    allocationId?: string,
  ): Promise<void> {
    const composite = `${clientId}:${key}`;
    const existing = this.records.get(composite);
    if (!existing) return;
    existing.state = "COMPLETED";
    existing.statusCode = statusCode;
    existing.body = JSON.stringify(body);
    existing.allocationId = allocationId ?? null;
  }

  async releaseIdempotency(clientId: string, key: string): Promise<void> {
    const composite = `${clientId}:${key}`;
    const existing = this.records.get(composite);
    if (existing && existing.state === "IN_PROGRESS") {
      this.records.delete(composite);
    }
  }
}

export class MemoryStore implements Store, IdempotencyRecordStore {
  readonly allocations = new Map<string, Allocation>();
  readonly byKey = new Map<string, { id: string; fingerprint: string }>();
  readonly outbox = new Map<string, MemoryOutboxRow>();
  readonly eventLog = new Map<
    string,
    Array<{ status: Status; reason: string | null; createdAt: string }>
  >();
  readonly accountSnapshots = new Map<string, AccountProjection[]>();
  readonly reconciliations = new Map<string, ReconciliationRun[]>();
  readonly idempotency: MemoryIdempotencyStore;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.idempotency = new MemoryIdempotencyStore(now);
  }

  acquireIdempotency(
    clientId: string,
    key: string,
    fingerprint: string,
    ttlSeconds?: number,
  ): Promise<IdempotencyAcquireResult> {
    return this.idempotency.acquireIdempotency(
      clientId,
      key,
      fingerprint,
      ttlSeconds,
    );
  }

  completeIdempotency(
    clientId: string,
    key: string,
    statusCode: number,
    body: unknown,
    allocationId?: string,
  ): Promise<void> {
    return this.idempotency.completeIdempotency(
      clientId,
      key,
      statusCode,
      body,
      allocationId,
    );
  }

  releaseIdempotency(clientId: string, key: string): Promise<void> {
    return this.idempotency.releaseIdempotency(clientId, key);
  }

  transitionStatus(
    id: string,
    nextStatus: Status,
    reason: string | null,
    postingId: string | null,
  ): void {
    const a = this.allocations.get(id);
    if (!a) return;
    if (["POSTED", "DECLINED"].includes(a.status)) {
      if (a.status !== nextStatus || a.postingId !== postingId) {
        throw new InvalidStateTransition(
          `Terminal allocation status (${a.status}) cannot regress to ${nextStatus}`,
        );
      }
      return;
    }
    if (!isValidAllocationTransition(a.status, nextStatus)) {
      throw new InvalidStateTransition(
        `Invalid allocation state transition: ${a.status} -> ${nextStatus}`,
      );
    }
    if (nextStatus === "POSTED" && postingId !== a.id) {
      throw new InvalidStateTransition("POSTED requires postingId === id");
    }
    if (nextStatus === "DECLINED" && postingId !== null) {
      throw new InvalidStateTransition("DECLINED requires postingId === null");
    }
    if (a.status !== nextStatus) {
      this.eventLog.get(id)?.push({
        status: nextStatus,
        reason,
        createdAt: new Date(this.now()).toISOString(),
      });
    }
    a.status = nextStatus;
    a.reason = reason;
    a.postingId = postingId;
    a.updatedAt = new Date(this.now()).toISOString();
  }

  async create(
    clientId: string,
    key: string,
    input: AllocationInput,
    _bank?: BankDetails,
    traceparent?: string | null,
  ): Promise<Allocation> {
    const fp = payloadFingerprint(input);
    const composite = `${clientId}:${key}`;
    const existing = this.byKey.get(composite);
    if (existing) {
      if (existing.fingerprint !== fp)
        throw new IdempotencyPayloadMismatch(
          "Idempotency key reused with different data",
        );
      return { ...this.allocations.get(existing.id)! };
    }
    const id = randomUUID();
    const ts = new Date(this.now()).toISOString();
    const allocation: Allocation = {
      id,
      clientId,
      ...input,
      status: "QUEUED",
      reason: null,
      postingId: null,
      ...(traceparent ? { traceparent } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    this.allocations.set(id, allocation);
    this.byKey.set(composite, { id, fingerprint: fp });
    this.outbox.set(id, {
      allocationId: id,
      status: "PENDING",
      nextAttemptAtUtc: this.now(),
      lockedUntilUtc: null,
      leaseToken: null,
      fencingToken: 0,
      failures: 0,
      lastError: null,
      traceparent: traceparent ?? null,
    });
    this.eventLog.set(id, [{ status: "QUEUED", reason: null, createdAt: ts }]);
    return { ...allocation };
  }

  async list(clientId: string, employee?: string): Promise<Allocation[]> {
    return Array.from(this.allocations.values())
      .filter(
        (a) =>
          a.clientId === clientId &&
          (!employee ||
            a.targetAccount === employee ||
            a.sourceAccount === employee),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((a) => ({ ...a }));
  }

  async get(id: string): Promise<Allocation | undefined> {
    const a = this.allocations.get(id);
    return a ? { ...a } : undefined;
  }

  async events(id: string): Promise<unknown[]> {
    return [...(this.eventLog.get(id) ?? [])];
  }

  async claim(leaseSeconds = 60): Promise<Job | undefined> {
    const current = this.now();
    const candidates = Array.from(this.outbox.values())
      .filter(
        (row) =>
          (row.status === "PENDING" &&
            row.nextAttemptAtUtc !== null &&
            row.nextAttemptAtUtc <= current) ||
          (row.status === "CLAIMED" &&
            row.lockedUntilUtc !== null &&
            row.lockedUntilUtc < current),
      )
      .sort((a, b) => {
        const at = a.nextAttemptAtUtc ?? 0;
        const bt = b.nextAttemptAtUtc ?? 0;
        if (at !== bt) return at - bt;
        return a.allocationId < b.allocationId ? -1 : 1;
      });
    const row = candidates[0];
    if (!row) return undefined;
    const leaseToken = randomUUID();
    row.status = "CLAIMED";
    row.lockedUntilUtc = current + leaseSeconds * 1000;
    row.leaseToken = leaseToken;
    row.fencingToken += 1;
    return {
      id: row.allocationId,
      token: leaseToken,
      fencingToken: row.fencingToken,
      failures: row.failures,
      traceparent: row.traceparent,
    };
  }

  async finish(job: Job, outcome: Outcome): Promise<void> {
    const row = this.outbox.get(job.id);
    if (
      !row ||
      row.status !== "CLAIMED" ||
      row.fencingToken !== job.fencingToken
    )
      return;
    const terminal = ["POSTED", "DECLINED", "NEEDS_REVIEW"].includes(
      outcome.status,
    );
    row.status = terminal
      ? outcome.status === "NEEDS_REVIEW"
        ? "DEAD_LETTER"
        : "COMPLETED"
      : "PENDING";
    row.lockedUntilUtc = null;
    row.leaseToken = null;
    row.failures = 0;
    row.lastError = null;
    row.nextAttemptAtUtc = terminal ? null : this.now() + 3_000;

    const a = this.allocations.get(job.id);
    if (!a) return;
    if (["POSTED", "DECLINED"].includes(a.status)) {
      row.status = "COMPLETED";
      row.nextAttemptAtUtc = null;
      return;
    }
    this.transitionStatus(job.id, outcome.status, outcome.reason, outcome.postingId);
  }

  async retry(job: Job, reason: string): Promise<void> {
    const row = this.outbox.get(job.id);
    if (
      !row ||
      row.status !== "CLAIMED" ||
      row.fencingToken !== job.fencingToken
    )
      return;
    const failures = job.failures + 1;
    const status: Status = failures >= 6 ? "NEEDS_REVIEW" : "VERIFYING";
    const delaySec = Math.min(60, 2 ** failures);
    row.failures = failures;
    row.lastError = reason.slice(0, 80);
    row.status = failures >= 6 ? "DEAD_LETTER" : "PENDING";
    row.lockedUntilUtc = null;
    row.leaseToken = null;
    row.nextAttemptAtUtc = failures >= 6 ? null : this.now() + delaySec * 1000;

    const a = this.allocations.get(job.id);
    if (!a) return;
    if (["POSTED", "DECLINED"].includes(a.status)) {
      row.status = "COMPLETED";
      row.nextAttemptAtUtc = null;
      return;
    }
    this.transitionStatus(job.id, status, row.lastError, a.postingId);
  }

  async deadLetter(job: Job, reason: string): Promise<void> {
    const row = this.outbox.get(job.id);
    if (
      !row ||
      row.status !== "CLAIMED" ||
      row.fencingToken !== job.fencingToken
    )
      return;
    row.lastError = reason.slice(0, 80);
    row.status = "DEAD_LETTER";
    row.lockedUntilUtc = null;
    row.leaseToken = null;
    row.nextAttemptAtUtc = null;

    const a = this.allocations.get(job.id);
    if (!a) return;
    if (["POSTED", "DECLINED"].includes(a.status)) {
      row.status = "COMPLETED";
      return;
    }
    this.transitionStatus(job.id, "NEEDS_REVIEW", row.lastError, null);
  }

  async wake(id: string): Promise<void> {
    const a = this.allocations.get(id);
    const row = this.outbox.get(id);
    if (!a || !row || ["POSTED", "DECLINED"].includes(a.status)) return;
    if (row.lockedUntilUtc !== null && row.lockedUntilUtc >= this.now()) return;
    row.status = "PENDING";
    row.nextAttemptAtUtc = this.now();
    row.lockedUntilUtc = null;
    row.leaseToken = null;
    row.failures = 0;
  }

  async accounts(
    clientId: string,
    employee?: string,
  ): Promise<AccountProjection[]> {
    const rows = this.accountSnapshots.get(clientId) ?? [];
    return employee ? rows.filter((r) => r.account === employee) : [...rows];
  }

  async syncAccounts(
    clientId: string,
    snapshot: AccountSnapshot,
  ): Promise<void> {
    const existing = this.accountSnapshots.get(clientId)?.[0];
    if (
      existing &&
      (existing.sequence > snapshot.sequence ||
        Date.parse(existing.observedAt) > Date.parse(snapshot.observedAt) ||
        existing.generation === snapshot.generation)
    )
      return;
    this.accountSnapshots.set(
      clientId,
      snapshot.balances.map((b) => ({
        ...b,
        generation: snapshot.generation,
        sequence: snapshot.sequence,
        observedAt: snapshot.observedAt,
      })),
    );
  }

  async scan(
    clientId: string,
  ): Promise<{ allocations: Allocation[]; truncated: boolean }> {
    const all = Array.from(this.allocations.values())
      .filter((a) => a.clientId === clientId)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return {
      allocations: all.slice(0, 5000).map((a) => ({ ...a })),
      truncated: all.length > 5000,
    };
  }

  async saveReconciliation(run: ReconciliationRun): Promise<void> {
    const list = this.reconciliations.get(run.clientId) ?? [];
    list.push(run);
    this.reconciliations.set(run.clientId, list);
  }

  async latestReconciliation(
    clientId: string,
  ): Promise<ReconciliationRun | undefined> {
    const list = this.reconciliations.get(clientId);
    return list && list.length ? list[list.length - 1] : undefined;
  }
}
