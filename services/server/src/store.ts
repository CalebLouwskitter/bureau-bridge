import { createHash, randomUUID } from "node:crypto";
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

export class Conflict extends Error {}
export interface Job {
  id: string;
  token: string;
  failures: number;
}
export interface Outcome {
  status: Status;
  reason: string | null;
  postingId: string | null;
}
export interface Store {
  create(
    clientId: string,
    key: string,
    input: AllocationInput,
  ): Promise<Allocation>;
  list(clientId: string, employee?: string): Promise<Allocation[]>;
  get(id: string): Promise<Allocation | undefined>;
  events(id: string): Promise<unknown[]>;
  claim(): Promise<Job | undefined>;
  finish(job: Job, outcome: Outcome): Promise<void>;
  retry(job: Job, reason: string): Promise<void>;
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
function map(row: any): Allocation {
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
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  };
}
export class SqlStore implements Store {
  constructor(readonly pool: sql.ConnectionPool) {}
  async create(clientId: string, key: string, input: AllocationInput) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    const id = randomUUID();
    try {
      await new sql.Request(tx)
        .input("id", sql.Char(36), id)
        .input("client", sql.VarChar(30), clientId)
        .input("key", sql.Char(36), key)
        .input("hash", sql.Char(64), fingerprint)
        .input("source", sql.Char(12), input.sourceAccount)
        .input("target", sql.Char(12), input.targetAccount)
        .input("amount", sql.BigInt, input.amountMinor).query(`
          INSERT dbo.Allocations (Id,ClientId,IdempotencyKey,Fingerprint,SourceAccount,TargetAccount,AmountMinor,Currency,Status)
          VALUES (@id,@client,@key,@hash,@source,@target,@amount,'ZAR','QUEUED');
          INSERT dbo.Outbox (AllocationId) VALUES (@id);
          INSERT dbo.AllocationEvents (AllocationId,Status) VALUES (@id,'QUEUED');`);
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
        throw new Conflict("Idempotency key reused with different data");
      return map(found.recordset[0]);
    }
  }
  async list(clientId: string, employee?: string) {
    const result = await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .input("employee", sql.Char(12), employee ?? null)
      .query(
        "SELECT TOP (100) * FROM dbo.Allocations WHERE ClientId=@client AND (@employee IS NULL OR TargetAccount=@employee) ORDER BY CreatedAt DESC",
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
  async claim(): Promise<Job | undefined> {
    const token = randomUUID();
    const result = await this.pool.request().input("token", sql.Char(36), token)
      .query(`
      ;WITH due AS (SELECT TOP (1) * FROM dbo.Outbox WITH (UPDLOCK,READPAST,ROWLOCK)
        WHERE DueAt<=SYSUTCDATETIME() AND (LeaseUntil IS NULL OR LeaseUntil<SYSUTCDATETIME()) ORDER BY DueAt)
      UPDATE due SET LeaseUntil=DATEADD(SECOND,60,SYSUTCDATETIME()),LeaseToken=@token
      OUTPUT inserted.AllocationId,inserted.Failures;`);
    const row = result.recordset[0];
    return row
      ? { id: row.AllocationId, token, failures: row.Failures }
      : undefined;
  }
  async finish(job: Job, outcome: Outcome) {
    const terminal = ["POSTED", "DECLINED", "NEEDS_REVIEW"].includes(
      outcome.status,
    );
    await this.pool
      .request()
      .input("id", sql.Char(36), job.id)
      .input("token", sql.Char(36), job.token)
      .input("status", sql.VarChar(24), outcome.status)
      .input("reason", sql.VarChar(80), outcome.reason)
      .input("posting", sql.Char(36), outcome.postingId)
      .input("terminal", sql.Bit, terminal).query(`
        SET XACT_ABORT ON; BEGIN TRAN;
        UPDATE dbo.Outbox SET LeaseUntil=NULL,LeaseToken=NULL,Failures=0,LastError=NULL,
          DueAt=CASE WHEN @terminal=1 THEN NULL ELSE DATEADD(SECOND,3,SYSUTCDATETIME()) END
          WHERE AllocationId=@id AND LeaseToken=@token;
        IF @@ROWCOUNT=1 BEGIN
          IF EXISTS(SELECT 1 FROM dbo.Allocations WHERE Id=@id AND Status IN ('POSTED','DECLINED'))
            UPDATE dbo.Outbox SET DueAt=NULL WHERE AllocationId=@id;
          INSERT dbo.AllocationEvents (AllocationId,Status,Reason)
            SELECT Id,@status,@reason FROM dbo.Allocations WHERE Id=@id AND Status<>@status AND Status NOT IN ('POSTED','DECLINED');
          UPDATE dbo.Allocations SET Status=@status,Reason=@reason,PostingId=@posting,UpdatedAt=SYSUTCDATETIME()
            WHERE Id=@id AND Status NOT IN ('POSTED','DECLINED');
        END; COMMIT;`);
  }
  async retry(job: Job, reason: string) {
    const failures = job.failures + 1;
    const status = failures >= 6 ? "NEEDS_REVIEW" : "VERIFYING";
    await this.pool
      .request()
      .input("id", sql.Char(36), job.id)
      .input("token", sql.Char(36), job.token)
      .input("failures", sql.Int, failures)
      .input("delay", sql.Int, Math.min(60, 2 ** failures))
      .input("status", sql.VarChar(24), status)
      .input("reason", sql.VarChar(80), reason.slice(0, 80)).query(`
        SET XACT_ABORT ON; BEGIN TRAN;
        UPDATE dbo.Outbox SET Failures=@failures,LastError=@reason,LeaseUntil=NULL,LeaseToken=NULL,
          DueAt=CASE WHEN @failures>=6 THEN NULL ELSE DATEADD(SECOND,@delay,SYSUTCDATETIME()) END
          WHERE AllocationId=@id AND LeaseToken=@token;
        IF @@ROWCOUNT=1 BEGIN
          IF EXISTS(SELECT 1 FROM dbo.Allocations WHERE Id=@id AND Status IN ('POSTED','DECLINED'))
            UPDATE dbo.Outbox SET DueAt=NULL WHERE AllocationId=@id;
          INSERT dbo.AllocationEvents (AllocationId,Status,Reason)
            SELECT Id,@status,@reason FROM dbo.Allocations WHERE Id=@id AND Status<>@status AND Status NOT IN ('POSTED','DECLINED');
          UPDATE dbo.Allocations SET Status=@status,Reason=@reason,UpdatedAt=SYSUTCDATETIME()
            WHERE Id=@id AND Status NOT IN ('POSTED','DECLINED');
        END; COMMIT;`);
  }
  async wake(id: string) {
    await this.pool.request().input("id", sql.Char(36), id)
      .query(`UPDATE o SET DueAt=SYSUTCDATETIME(),Failures=0 FROM dbo.Outbox o
        JOIN dbo.Allocations a ON a.Id=o.AllocationId
        WHERE o.AllocationId=@id AND a.Status NOT IN ('POSTED','DECLINED')
        AND (o.LeaseUntil IS NULL OR o.LeaseUntil<SYSUTCDATETIME());`);
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
          (RunId,Severity,Code,Reference,Details) SELECT @id,severity,code,reference,details FROM OPENJSON(@items)
          WITH (severity VARCHAR(8),code VARCHAR(48),reference CHAR(36),details NVARCHAR(1000));`);
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
        "SELECT Severity AS severity,Code AS code,Reference AS reference,Details AS details FROM dbo.ReconciliationFindings WHERE RunId=@id ORDER BY Id",
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
      findings: findings.recordset,
    };
  }
}
