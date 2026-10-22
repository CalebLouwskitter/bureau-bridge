import {
  parseTransfer,
  SETTLEMENT_ACCOUNT,
  type AllocationInput,
  type Payout,
  type PayoutFile,
} from "@bureau/contracts";
import { PAYOUT_CUTOFF } from "./config.ts";
import { actionDateFor } from "./business-calendar.ts";
import {
  buildEft,
  parseResponse,
  USER_CODE,
  type BankResponse,
  type EftItem,
} from "./eft.ts";

export interface StoredPayoutFile extends PayoutFile {
  content: string;
}
export interface FileDraft {
  fileId: string;
  generation: number;
  items: EftItem[];
}
export interface ImportResult {
  fileId: string;
  status: "RESPONSE_PROCESSED" | "REJECTED";
  duplicate: boolean;
  paid: number;
  returned: number;
}
export interface PayoutStore {
  // Creates the core debit allocation, its outbox row and the instruction in
  // one transaction. Replaying the key returns the original instruction.
  createPayout(
    clientId: string,
    key: string,
    input: AllocationInput,
  ): Promise<Payout>;
  listPayouts(clientId: string, employee?: string): Promise<Payout[]>;
  // Claims every debited, unfiled instruction for one new file. Replaying the
  // key returns the same file; undefined means nothing is ready to pay.
  createPayoutFile(
    clientId: string,
    key: string,
    actionDate: string,
    build: (draft: FileDraft) => string,
  ): Promise<PayoutFile | undefined>;
  listPayoutFiles(clientId: string): Promise<PayoutFile[]>;
  payoutFile(
    clientId: string,
    id: string,
  ): Promise<StoredPayoutFile | undefined>;
  markSubmission(
    clientId: string,
    id: string,
    status: "SUBMITTED" | "SUBMISSION_UNKNOWN",
  ): Promise<void>;
  // Records the bank's answer once per file and queues a core credit for each
  // returned item. Reprocessing the same response is a no-op.
  importBankResponse(
    clientId: string,
    response: BankResponse,
    content: string,
  ): Promise<ImportResult>;
  scanPayouts(clientId: string): Promise<{
    payouts: Payout[];
    files: StoredPayoutFile[];
    truncated: boolean;
  }>;
}
export interface Bank {
  submit(content: string): Promise<string>;
  inquire(userCode: string, generation: number): Promise<string | undefined>;
}
export class NotFound extends Error {}
export class BankUnavailable extends Error {}

export class BankClient implements Bank {
  constructor(
    private base: string,
    private key: string,
  ) {}
  private async call(path: string, body?: string) {
    const response = await fetch(this.base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body,
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`BANK_HTTP_${response.status}`);
    return response.text();
  }
  async submit(content: string) {
    const text = await this.call("/files", content);
    if (text === undefined) throw new Error("BANK_HTTP_404");
    return text;
  }
  async inquire(userCode: string, generation: number) {
    return this.call(`/files/${userCode}/${generation}/response`);
  }
}

export function payoutInput(body: unknown): AllocationInput {
  const v = (body ?? {}) as {
    employeeAccount?: unknown;
    amountMinor?: unknown;
  };
  const input = parseTransfer({
    sourceAccount: v.employeeAccount,
    targetAccount: SETTLEMENT_ACCOUNT,
    amountMinor: v.amountMinor,
    currency: "ZAR",
  });
  return input;
}
// Bank action dates follow the bureau's business day.
export const actionDate = (now = new Date()) =>
  actionDateFor(now, { cutOff: process.env.PAYOUT_CUTOFF ?? PAYOUT_CUTOFF });

export function generateFile(
  store: PayoutStore,
  clientId: string,
  key: string,
  now = new Date(),
) {
  const date = actionDate(now);
  return store.createPayoutFile(clientId, key, date, (draft) =>
    buildEft({ userCode: USER_CODE, actionDate: date, ...draft }),
  );
}

export async function importResponse(
  store: PayoutStore,
  clientId: string,
  content: string,
) {
  return store.importBankResponse(clientId, parseResponse(content), content);
}

export async function submitFile(
  store: PayoutStore,
  bank: Bank,
  clientId: string,
  id: string,
): Promise<ImportResult> {
  const file = await store.payoutFile(clientId, id);
  if (!file) throw new NotFound("Payout file not found");
  // A timeout can hide a file the bank already received, so ask about this
  // generation first. An unanswered question never authorizes a resend.
  let response: string | undefined;
  try {
    response = await bank.inquire(USER_CODE, file.generation);
  } catch {
    throw new BankUnavailable("The bank could not confirm this file");
  }
  if (!response) {
    await store.markSubmission(clientId, id, "SUBMITTED");
    try {
      response = await bank.submit(file.content);
    } catch {
      await store.markSubmission(clientId, id, "SUBMISSION_UNKNOWN");
      throw new BankUnavailable(
        "The bank outcome is unknown; submit again to ask the bank",
      );
    }
  }
  return importResponse(store, clientId, response);
}
