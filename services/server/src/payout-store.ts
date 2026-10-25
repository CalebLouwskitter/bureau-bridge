import { randomUUID } from "node:crypto";
import sql from "mssql";
import {
  BANK_DETAILS,
  payoutStatus,
  SETTLEMENT_ACCOUNT,
  type AllocationInput,
  type Payout,
  type PayoutFile,
} from "@bureau/contracts";
import { Conflict, SqlStore } from "./store.ts";
import { hashTotal, parseEft, sha256, type BankResponse } from "./eft.ts";
import { fingerprint, returnKey } from "./ids.ts";
import {
  Forbidden,
  NotFound,
  payoutApprovalThresholdCents,
  type FileDraft,
  type ImportResult,
  type PayoutStore,
  type StoredPayoutFile,
} from "./payouts.ts";

const PAYOUT_SELECT = `SELECT i.*,d.Status AS DebitStatus,r.Status AS ReturnStatus
  FROM dbo.PayoutInstructions i JOIN dbo.Allocations d ON d.Id=i.Id
  LEFT JOIN dbo.Allocations r ON r.Id=i.ReturnAllocationId`;
function mapPayout(row: any): Payout {
  const p = {
    id: row.Id,
    clientId: row.ClientId,
    employeeAccount: row.EmployeeAccount,
    amountMinor: Number(row.AmountMinor),
    currency: "ZAR" as const,
    branch: row.Branch,
    bankAccount: row.BankAccount,
    holder: row.Holder,
    debitStatus: row.DebitStatus,
    fileId: row.PayoutFileId,
    bankOutcome: row.BankOutcome,
    returnCode: row.ReturnCode,
    returnAllocationId: row.ReturnAllocationId,
    returnStatus: row.ReturnStatus,
    createdAt: row.CreatedAt.toISOString(),
  };
  return { ...p, status: payoutStatus(p) };
}
function mapFile(row: any): StoredPayoutFile {
  return {
    id: row.Id ?? row.id,
    clientId: row.ClientId ?? row.clientId,
    generation: row.Generation ?? row.generation,
    actionDate:
      row.ActionDate instanceof Date
        ? row.ActionDate.toISOString().slice(0, 10)
        : typeof row.ActionDate === "string"
          ? row.ActionDate.slice(0, 10)
          : typeof row.actionDate === "string"
            ? row.actionDate.slice(0, 10)
            : String(row.ActionDate ?? row.actionDate),
    itemCount: Number(row.ItemCount ?? row.itemCount),
    amountTotal: Number(row.AmountTotal ?? row.amountTotal),
    hashTotal: Number(row.HashTotal ?? row.hashTotal),
    sha256: row.Sha256 ?? row.sha256,
    status: row.Status ?? row.status,
    createdAt:
      row.CreatedAt instanceof Date
        ? row.CreatedAt.toISOString()
        : (row.CreatedAt ?? row.createdAt),
    content: row.Content ?? row.content,
    createdBy: row.CreatedBy ?? row.createdBy ?? null,
    approvedBy: row.ApprovedBy ?? row.approvedBy ?? null,
    approvedAt:
      row.ApprovedAt instanceof Date
        ? row.ApprovedAt.toISOString()
        : (row.ApprovedAt ?? row.approvedAt ?? null),
  };
}
const withoutContent = ({
  content: _,
  ...file
}: StoredPayoutFile): PayoutFile => file;

export class SqlPayoutStore extends SqlStore implements PayoutStore {
  async createPayout(clientId: string, key: string, input: AllocationInput) {
    const bank = BANK_DETAILS[input.sourceAccount];
    if (!bank || input.targetAccount !== SETTLEMENT_ACCOUNT)
      throw new Conflict("Payouts need a registered bank account");
    const allocation = await this.create(clientId, key, input, bank);
    const payout = await this.payout(allocation.id);
    // The key already belongs to an allocation with this payload.
    if (!payout)
      throw new Conflict("Idempotency key reused for another request");
    return payout;
  }
  async payout(id: string) {
    const result = await this.pool
      .request()
      .input("id", sql.Char(36), id)
      .query(`${PAYOUT_SELECT} WHERE i.Id=@id`);
    return result.recordset[0] ? mapPayout(result.recordset[0]) : undefined;
  }
  async listPayouts(clientId: string, employee?: string) {
    const result = await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .input("employee", sql.Char(12), employee ?? null)
      .query(
        `${PAYOUT_SELECT} WHERE i.ClientId=@client AND (@employee IS NULL OR i.EmployeeAccount=@employee)
          ORDER BY i.CreatedAt DESC OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY`,
      );
    return result.recordset.map(mapPayout);
  }
  async createPayoutFile(
    clientId: string,
    key: string,
    actionDate: string,
    build: (draft: FileDraft) => string,
    createdBy?: string,
    thresholdCents = payoutApprovalThresholdCents(),
  ): Promise<PayoutFile | undefined> {
    for (let attempt = 0; ; attempt++) {
      const tx = new sql.Transaction(this.pool);
      await tx.begin();
      try {
        const request = () =>
          new sql.Request(tx)
            .input("client", sql.VarChar(30), clientId)
            .input("key", sql.Char(36), key);
        // The range lock serializes file generation per client, so the
        // generation number and the claimed instructions cannot interleave.
        const next = (
          await request().query(`SET XACT_ABORT ON;
            SELECT ISNULL(MAX(Generation),0)+1 AS next FROM dbo.PayoutFiles WITH (UPDLOCK,HOLDLOCK)
            WHERE ClientId=@client`)
        ).recordset[0].next as number;
        const replay = (
          await request().query(
            "SELECT * FROM dbo.PayoutFiles WHERE ClientId=@client AND IdempotencyKey=@key",
          )
        ).recordset[0];
        if (replay) {
          await tx.commit();
          return withoutContent(mapFile(replay));
        }
        const rows = (
          await request()
            .query(`SELECT TOP (500) i.Id,i.Branch,i.BankAccount,i.AmountMinor,i.Holder
            FROM dbo.PayoutInstructions i WITH (UPDLOCK,HOLDLOCK) JOIN dbo.Allocations a ON a.Id=i.Id
            WHERE i.ClientId=@client AND i.PayoutFileId IS NULL AND a.Status='POSTED' ORDER BY i.Id`)
        ).recordset;
        if (!rows.length) {
          await tx.commit();
          return undefined;
        }
        const fileId = randomUUID();
        const content = build({
          fileId,
          generation: next,
          items: rows.map((r: any) => ({
            reference: r.Id,
            branch: r.Branch,
            account: r.BankAccount,
            amountMinor: Number(r.AmountMinor),
            holder: r.Holder,
          })),
        });
        // Check the built file the way the bank will before storing it.
        const parsed = parseEft(content);
        const amountTotal = parsed.items.reduce((s, i) => s + i.amountMinor, 0);
        const status =
          amountTotal >= thresholdCents ? "AWAITING_APPROVAL" : "GENERATED";
        await request()
          .input("id", sql.Char(36), fileId)
          .input("generation", sql.Int, next)
          .input("date", sql.Date, new Date(`${actionDate}T00:00:00Z`))
          .input("count", sql.Int, parsed.items.length)
          .input("amount", sql.BigInt, amountTotal)
          .input("hashTotal", sql.BigInt, Number(hashTotal(parsed.items)))
          .input("sha", sql.Char(64), sha256(content))
          .input("content", sql.VarChar(sql.MAX), content)
          .input("status", sql.VarChar(20), status)
          .input("createdBy", sql.VarChar(60), createdBy ?? null)
          .input(
            "ids",
            sql.NVarChar(sql.MAX),
            JSON.stringify(rows.map((r: any) => r.Id)),
          )
          .query(`INSERT dbo.PayoutFiles (Id,ClientId,IdempotencyKey,Generation,ActionDate,ItemCount,AmountTotal,HashTotal,Sha256,Content,Status,CreatedBy)
            VALUES (@id,@client,@key,@generation,@date,@count,@amount,@hashTotal,@sha,@content,@status,@createdBy);
            UPDATE dbo.PayoutInstructions SET PayoutFileId=@id
              WHERE PayoutFileId IS NULL AND Id IN (SELECT value FROM OPENJSON(@ids));
            IF @@ROWCOUNT<>@count THROW 51000,'Payout instructions changed during file generation',1;`);
        await tx.commit();
        return withoutContent((await this.payoutFile(clientId, fileId))!);
      } catch (error: any) {
        await tx.rollback().catch(() => {});
        // A concurrent request with the same key or a deadlock victim retries
        // once and then sees the committed file.
        if (attempt === 0 && [1205, 2601, 2627].includes(error.number))
          continue;
        throw error;
      }
    }
  }
  async listPayoutFiles(clientId: string) {
    const result = await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .query(
        `SELECT TOP (100) Id,ClientId,Generation,ActionDate,ItemCount,AmountTotal,HashTotal,Sha256,Status,
          CreatedAt,CreatedBy,ApprovedBy,ApprovedAt,'' AS Content FROM dbo.PayoutFiles WHERE ClientId=@client ORDER BY Generation DESC`,
      );
    return result.recordset.map((r: any) => withoutContent(mapFile(r)));
  }
  async payoutFile(clientId: string, id: string) {
    const result = await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .input("id", sql.Char(36), id)
      .query("SELECT * FROM dbo.PayoutFiles WHERE ClientId=@client AND Id=@id");
    return result.recordset[0] ? mapFile(result.recordset[0]) : undefined;
  }
  async approvePayoutFile(
    clientId: string,
    id: string,
    approver: string,
  ): Promise<PayoutFile> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const request = () =>
        new sql.Request(tx)
          .input("client", sql.VarChar(30), clientId)
          .input("id", sql.Char(36), id);
      const row = (
        await request().query(`SET XACT_ABORT ON;
          SELECT * FROM dbo.PayoutFiles WITH (UPDLOCK,HOLDLOCK) WHERE ClientId=@client AND Id=@id`)
      ).recordset[0];
      if (!row) throw new NotFound("Payout file not found");
      if (row.CreatedBy && row.CreatedBy === approver) {
        throw new Forbidden("Creator cannot approve payout file");
      }
      if (row.Status === "AWAITING_APPROVAL") {
        await request()
          .input("approver", sql.VarChar(60), approver)
          .query(`UPDATE dbo.PayoutFiles
            SET Status='GENERATED', ApprovedBy=@approver, ApprovedAt=SYSUTCDATETIME(), UpdatedAt=SYSUTCDATETIME()
            WHERE ClientId=@client AND Id=@id AND Status='AWAITING_APPROVAL'`);
        const updated = (
          await request().query(
            "SELECT * FROM dbo.PayoutFiles WHERE ClientId=@client AND Id=@id",
          )
        ).recordset[0];
        await tx.commit();
        return withoutContent(mapFile(updated));
      }
      await tx.commit();
      return withoutContent(mapFile(row));
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  }
  async markSubmission(
    clientId: string,
    id: string,
    status: "SUBMITTED" | "SUBMISSION_UNKNOWN",
  ) {
    await this.pool
      .request()
      .input("client", sql.VarChar(30), clientId)
      .input("id", sql.Char(36), id)
      .input("status", sql.VarChar(20), status)
      .query(`UPDATE dbo.PayoutFiles SET Status=@status,UpdatedAt=SYSUTCDATETIME()
        WHERE ClientId=@client AND Id=@id AND Status IN ('GENERATED','SUBMITTED','SUBMISSION_UNKNOWN')`);
  }
  async importBankResponse(
    clientId: string,
    response: BankResponse,
    content: string,
  ): Promise<ImportResult> {
    const hash = sha256(content);
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const request = () =>
        new sql.Request(tx)
          .input("client", sql.VarChar(30), clientId)
          .input("file", sql.Char(36), response.fileId);
      const file = (
        await request().query(`SET XACT_ABORT ON;
          SELECT * FROM dbo.PayoutFiles WITH (UPDLOCK,HOLDLOCK) WHERE Id=@file AND ClientId=@client`)
      ).recordset[0];
      if (!file)
        throw new NotFound("The response names an unknown payout file");
      if (file.Generation !== response.generation)
        throw new Conflict("The response generation differs from the file");
      const counts = (
        await request().query(`SELECT
          SUM(CASE WHEN BankOutcome='PAID' THEN 1 ELSE 0 END) AS paid,
          SUM(CASE WHEN BankOutcome='RETURNED' THEN 1 ELSE 0 END) AS returned
          FROM dbo.PayoutInstructions WHERE PayoutFileId=@file`)
      ).recordset[0];
      const prior = (
        await request().query(
          "SELECT Sha256 FROM dbo.BankResponses WHERE PayoutFileId=@file",
        )
      ).recordset[0];
      if (prior) {
        await tx.commit();
        if (prior.Sha256 !== hash)
          throw new Conflict(
            "A different bank response was already processed for this file",
          );
        return {
          fileId: response.fileId,
          status: file.Status,
          duplicate: true,
          paid: counts.paid ?? 0,
          returned: counts.returned ?? 0,
        };
      }
      const record = () =>
        request()
          .input("sha", sql.Char(64), hash)
          .input("status", sql.VarChar(8), response.status)
          .input("content", sql.VarChar(sql.MAX), content)
          .query(`INSERT dbo.BankResponses (PayoutFileId,Sha256,Status,Content) VALUES (@file,@sha,@status,@content);
            UPDATE dbo.PayoutFiles SET Status=CASE WHEN @status='ACCEPTED' THEN 'RESPONSE_PROCESSED' ELSE 'REJECTED' END,
              UpdatedAt=SYSUTCDATETIME() WHERE Id=@file;`);
      if (response.status === "REJECTED") {
        // Nothing in a rejected file was paid; its items can go in a new file.
        await record();
        await request().query(
          "UPDATE dbo.PayoutInstructions SET PayoutFileId=NULL WHERE PayoutFileId=@file",
        );
        await tx.commit();
        return {
          fileId: response.fileId,
          status: "REJECTED",
          duplicate: false,
          paid: 0,
          returned: 0,
        };
      }
      const items = new Map<string, any>(
        (
          await request().query(
            "SELECT Id,EmployeeAccount,AmountMinor FROM dbo.PayoutInstructions WITH (UPDLOCK) WHERE PayoutFileId=@file",
          )
        ).recordset.map((r: any) => [r.Id, r]),
      );
      if (
        items.size !== response.results.length ||
        response.results.some((r) => !items.has(r.reference))
      )
        throw new Conflict("Bank results do not match the file items");
      await record();
      for (const result of response.results) {
        const item = items.get(result.reference);
        if (result.outcome === "PAID") {
          await request()
            .input("id", sql.Char(36), result.reference)
            .query(
              "UPDATE dbo.PayoutInstructions SET BankOutcome='PAID' WHERE Id=@id",
            );
          continue;
        }
        // The return credit is a new core posting with its own reference,
        // keyed by the payout so no response can credit the same item twice.
        const input: AllocationInput = {
          sourceAccount: SETTLEMENT_ACCOUNT,
          targetAccount: item.EmployeeAccount,
          amountMinor: Number(item.AmountMinor),
          currency: "ZAR",
        };
        await request()
          .input("id", sql.Char(36), result.reference)
          .input("returnId", sql.Char(36), randomUUID())
          .input("returnKey", sql.Char(36), returnKey(result.reference))
          .input("hash", sql.Char(64), fingerprint(input))
          .input("target", sql.Char(12), input.targetAccount)
          .input("amount", sql.BigInt, input.amountMinor)
          .input("code", sql.Char(2), result.code)
          .query(`INSERT dbo.Allocations (Id,ClientId,IdempotencyKey,Fingerprint,SourceAccount,TargetAccount,AmountMinor,Currency,Status)
              VALUES (@returnId,@client,@returnKey,@hash,'${SETTLEMENT_ACCOUNT}',@target,@amount,'ZAR','QUEUED');
            INSERT dbo.Outbox (AllocationId) VALUES (@returnId);
            INSERT dbo.AllocationEvents (AllocationId,Status,Reason) VALUES (@returnId,'QUEUED','BANK_RETURN_' + @code);
            UPDATE dbo.PayoutInstructions SET BankOutcome='RETURNED',ReturnCode=@code,ReturnAllocationId=@returnId WHERE Id=@id;`);
      }
      await tx.commit();
      const returned = response.results.filter(
        (r) => r.outcome === "RETURNED",
      ).length;
      return {
        fileId: response.fileId,
        status: "RESPONSE_PROCESSED",
        duplicate: false,
        paid: response.results.length - returned,
        returned,
      };
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  }
  async scanPayouts(clientId: string) {
    const request = () =>
      this.pool.request().input("client", sql.VarChar(30), clientId);
    const [payouts, files] = await Promise.all([
      request().query(`${PAYOUT_SELECT} WHERE i.ClientId=@client
        ORDER BY i.Id OFFSET 0 ROWS FETCH NEXT 5001 ROWS ONLY`),
      request().query(
        "SELECT TOP (5001) * FROM dbo.PayoutFiles WHERE ClientId=@client ORDER BY Generation",
      ),
    ]);
    return {
      payouts: payouts.recordset.slice(0, 5000).map(mapPayout),
      files: files.recordset.slice(0, 5000).map(mapFile),
      truncated:
        payouts.recordset.length > 5000 || files.recordset.length > 5000,
    };
  }
}

export class MemoryPayoutStore implements PayoutStore {
  readonly payouts = new Map<string, Payout>();
  readonly files = new Map<string, StoredPayoutFile>();
  readonly idempotency = new Map<string, string>();
  readonly submissions: string[] = [];

  async createPayout(
    clientId: string,
    key: string,
    input: AllocationInput,
  ): Promise<Payout> {
    const existingId = this.idempotency.get(`${clientId}:payout:${key}`);
    if (existingId) return this.payouts.get(existingId)!;
    const id = randomUUID();
    const p: Payout = {
      id,
      clientId,
      employeeAccount: input.targetAccount,
      amountMinor: input.amountMinor,
      currency: "ZAR",
      branch: "990001",
      bankAccount: "10000000017",
      holder: "EMPLOYEE",
      debitStatus: "POSTED",
      fileId: null,
      bankOutcome: null,
      returnCode: null,
      returnAllocationId: null,
      returnStatus: null,
      status: "READY",
      createdAt: new Date().toISOString(),
    };
    this.payouts.set(id, p);
    this.idempotency.set(`${clientId}:payout:${key}`, id);
    return p;
  }

  async listPayouts(clientId: string, employee?: string): Promise<Payout[]> {
    return Array.from(this.payouts.values()).filter(
      (p) =>
        p.clientId === clientId &&
        (!employee || p.employeeAccount === employee),
    );
  }

  async createPayoutFile(
    clientId: string,
    key: string,
    actionDate: string,
    build: (draft: FileDraft) => string,
    createdBy?: string,
    thresholdCents = payoutApprovalThresholdCents(),
  ): Promise<PayoutFile | undefined> {
    const existingId = this.idempotency.get(`${clientId}:file:${key}`);
    if (existingId) {
      return withoutContent(this.files.get(existingId)!);
    }
    const ready = Array.from(this.payouts.values()).filter(
      (p) => p.clientId === clientId && !p.fileId && p.debitStatus === "POSTED",
    );
    if (!ready.length) return undefined;
    const fileId = randomUUID();
    const generation =
      Array.from(this.files.values()).filter((f) => f.clientId === clientId)
        .length + 1;
    const items = ready.map((p) => ({
      reference: p.id,
      branch: p.branch,
      account: p.bankAccount,
      amountMinor: p.amountMinor,
      holder: p.holder,
    }));
    const content = build({ fileId, generation, items });
    const parsed = parseEft(content);
    const amountTotal = parsed.items.reduce((s, i) => s + i.amountMinor, 0);
    const status =
      amountTotal >= thresholdCents ? "AWAITING_APPROVAL" : "GENERATED";
    const file: StoredPayoutFile = {
      id: fileId,
      clientId,
      generation,
      actionDate,
      itemCount: parsed.items.length,
      amountTotal,
      hashTotal: Number(hashTotal(parsed.items)),
      sha256: sha256(content),
      status,
      createdAt: new Date().toISOString(),
      content,
      createdBy: createdBy ?? null,
      approvedBy: null,
      approvedAt: null,
    };
    for (const p of ready) {
      p.fileId = fileId;
      p.status = "IN_FILE";
    }
    this.files.set(fileId, file);
    this.idempotency.set(`${clientId}:file:${key}`, fileId);
    return withoutContent(file);
  }

  async listPayoutFiles(clientId: string): Promise<PayoutFile[]> {
    return Array.from(this.files.values())
      .filter((f) => f.clientId === clientId)
      .map(withoutContent);
  }

  async payoutFile(
    clientId: string,
    id: string,
  ): Promise<StoredPayoutFile | undefined> {
    const file = this.files.get(id);
    return file && file.clientId === clientId ? { ...file } : undefined;
  }

  async approvePayoutFile(
    clientId: string,
    id: string,
    approver: string,
  ): Promise<PayoutFile> {
    const file = this.files.get(id);
    if (!file || file.clientId !== clientId) {
      throw new NotFound("Payout file not found");
    }
    if (file.createdBy && file.createdBy === approver) {
      throw new Forbidden("Creator cannot approve payout file");
    }
    if (file.status === "AWAITING_APPROVAL") {
      file.status = "GENERATED";
      file.approvedBy = approver;
      file.approvedAt = new Date().toISOString();
    }
    return withoutContent(file);
  }

  async markSubmission(
    clientId: string,
    id: string,
    status: "SUBMITTED" | "SUBMISSION_UNKNOWN",
  ): Promise<void> {
    const file = this.files.get(id);
    if (file && file.clientId === clientId) {
      file.status = status;
      this.submissions.push(status);
    }
  }

  async importBankResponse(
    clientId: string,
    response: BankResponse,
    _content: string,
  ): Promise<ImportResult> {
    const file = this.files.get(response.fileId);
    if (!file || file.clientId !== clientId) {
      throw new NotFound("The response names an unknown payout file");
    }
    file.status =
      response.status === "ACCEPTED" ? "RESPONSE_PROCESSED" : "REJECTED";
    return {
      fileId: response.fileId,
      status: file.status,
      duplicate: false,
      paid: response.results.filter((r) => r.outcome === "PAID").length,
      returned: response.results.filter((r) => r.outcome === "RETURNED").length,
    };
  }

  async scanPayouts(clientId: string) {
    return {
      payouts: await this.listPayouts(clientId),
      files: Array.from(this.files.values()).filter((f) => f.clientId === clientId),
      truncated: false,
    };
  }
}
