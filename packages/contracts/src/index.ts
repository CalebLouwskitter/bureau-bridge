export const SOURCE_ACCOUNT = "INS000000001";
export const EMPLOYEE_ACCOUNTS = [
  "EMP000000001",
  "EMP000000002",
  "EMP000000003",
] as const;
// Value paid out by EFT moves into this core account, so the fixed demo total
// still proves conservation. A bank return moves it back to the employee.
export const SETTLEMENT_ACCOUNT = "BNK000000001";
export type Route = "ALLOCATION" | "PAYOUT" | "RETURN";
// Fictional bank details for payable accounts that may be paid out. The
// suspended fixture has none, so it cannot receive a payout instruction.
export const BANK_DETAILS: Record<
  string,
  { branch: string; account: string; holder: string }
> = {
  EMP000000001: {
    branch: "990001",
    account: "10000000017",
    holder: "EMPLOYEE ONE",
  },
  EMP000000002: {
    branch: "990002",
    account: "20000000025",
    holder: "EMPLOYEE TWO",
  },
};
export type Status =
  | "QUEUED"
  | "AWAITING_BATCH"
  | "PROCESSING"
  | "VERIFYING"
  | "POSTED"
  | "DECLINED"
  | "NEEDS_REVIEW";
export type Role = "payroll" | "employee" | "ops";
export interface AllocationInput {
  sourceAccount: string;
  targetAccount: string;
  amountMinor: number;
  currency: "ZAR";
}
export interface Allocation extends AllocationInput {
  id: string;
  clientId: string;
  status: Status;
  reason: string | null;
  postingId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Principal {
  username: string;
  role: Role;
  clientId: string;
  employeeAccount?: string;
}
export interface AccountProjection {
  account: string;
  amountMinor: number;
  currency: "ZAR";
  kind: "CLIENT" | "EMPLOYEE" | "SETTLEMENT";
  state: "ACTIVE" | "SUSPENDED";
  generation: string;
  sequence: number;
  observedAt: string;
}
export interface AccountSnapshot {
  generation: string;
  sequence: number;
  observedAt: string;
  balances: Omit<AccountProjection, "generation" | "sequence" | "observedAt">[];
}
export interface ReconciliationFinding {
  severity: "HIGH" | "WARN" | "INFO";
  code: string;
  reference: string | null;
  details: string;
}
export interface ReconciliationRun {
  id: string;
  clientId: string;
  createdAt: string;
  generation: string;
  observedAt: string;
  modernCount: number;
  intakeCount: number;
  coreCount: number;
  truncated: boolean;
  findings: ReconciliationFinding[];
}
export type PayoutStatus =
  | "AWAITING_DEBIT"
  | "DEBIT_DECLINED"
  | "NEEDS_REVIEW"
  | "READY"
  | "IN_FILE"
  | "PAID"
  | "RETURN_PENDING"
  | "RETURNED";
// One reference identifies the payout instruction, its core debit, and its
// line in the EFT file. A bank return gets its own core credit reference.
export interface Payout {
  id: string;
  clientId: string;
  employeeAccount: string;
  amountMinor: number;
  currency: "ZAR";
  branch: string;
  bankAccount: string;
  holder: string;
  debitStatus: Status;
  fileId: string | null;
  bankOutcome: "PAID" | "RETURNED" | null;
  returnCode: string | null;
  returnAllocationId: string | null;
  returnStatus: Status | null;
  status: PayoutStatus;
  createdAt: string;
}
export type PayoutFileStatus =
  | "AWAITING_APPROVAL"
  | "GENERATED"
  | "SUBMITTED"
  | "SUBMISSION_UNKNOWN"
  | "RESPONSE_PROCESSED"
  | "REJECTED";
export interface PayoutFile {
  id: string;
  clientId: string;
  generation: number;
  actionDate: string;
  itemCount: number;
  amountTotal: number;
  hashTotal: number;
  sha256: string;
  status: PayoutFileStatus;
  createdAt: string;
  createdBy?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
}
export function payoutStatus(
  p: Pick<Payout, "debitStatus" | "fileId" | "bankOutcome" | "returnStatus">,
): PayoutStatus {
  if (p.bankOutcome === "RETURNED")
    return p.returnStatus === "POSTED" ? "RETURNED" : "RETURN_PENDING";
  if (p.bankOutcome === "PAID") return "PAID";
  if (p.fileId) return "IN_FILE";
  if (p.debitStatus === "POSTED") return "READY";
  if (p.debitStatus === "DECLINED") return "DEBIT_DECLINED";
  if (p.debitStatus === "NEEDS_REVIEW") return "NEEDS_REVIEW";
  return "AWAITING_DEBIT";
}
export interface PendingRequest {
  key: string;
  amountMinor: number;
  targetAccount: string;
}
// A damaged local cache must not prevent sign-in or invent a new retry payload.
export function parsePending(raw: string | null): PendingRequest | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.key !== "string" || !UUID.test(value.key))
      return undefined;
    const input = parseAllocation({
      ...value,
      sourceAccount: SOURCE_ACCOUNT,
      currency: "ZAR",
    });
    return {
      key: value.key,
      amountMinor: input.amountMinor,
      targetAccount: input.targetAccount,
    };
  } catch {
    return undefined;
  }
}
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isEmployee = (account: unknown) =>
  EMPLOYEE_ACCOUNTS.includes(account as (typeof EMPLOYEE_ACCOUNTS)[number]);
export function routeOf(t: {
  sourceAccount: unknown;
  targetAccount: unknown;
}): Route | undefined {
  if (t.sourceAccount === SOURCE_ACCOUNT && isEmployee(t.targetAccount))
    return "ALLOCATION";
  if (
    t.targetAccount === SETTLEMENT_ACCOUNT &&
    Object.hasOwn(BANK_DETAILS, t.sourceAccount as string)
  )
    return "PAYOUT";
  if (
    t.sourceAccount === SETTLEMENT_ACCOUNT &&
    Object.hasOwn(BANK_DETAILS, t.targetAccount as string)
  )
    return "RETURN";
  return undefined;
}
// Payroll users create allocations; payouts and returns are created only by
// the payments hub, through parseTransfer.
export function parseAllocation(value: unknown): AllocationInput {
  const input = parseTransfer(value);
  if (routeOf(input) !== "ALLOCATION")
    throw new Error("Choose one of the seeded demo accounts");
  return input;
}
export function parseTransfer(value: unknown): AllocationInput {
  if (!value || typeof value !== "object")
    throw new Error("Expected an allocation object");
  const v = value as Record<string, unknown>;
  if (
    !routeOf({ sourceAccount: v.sourceAccount, targetAccount: v.targetAccount })
  )
    throw new Error("Choose one of the seeded demo accounts");
  if (
    typeof v.amountMinor !== "number" ||
    !Number.isSafeInteger(v.amountMinor) ||
    v.amountMinor < 1 ||
    v.amountMinor > 999999999999
  )
    throw new Error(
      "amountMinor must be an integer between 1 and 999999999999",
    );
  if (v.currency !== "ZAR") throw new Error("Only ZAR is supported");
  return {
    sourceAccount: v.sourceAccount as string,
    targetAccount: v.targetAccount as string,
    amountMinor: v.amountMinor,
    currency: "ZAR",
  };
}
