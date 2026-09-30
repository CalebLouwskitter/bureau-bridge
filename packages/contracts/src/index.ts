export const SOURCE_ACCOUNT = "INS000000001";
export const EMPLOYEE_ACCOUNTS = [
  "EMP000000001",
  "EMP000000002",
  "EMP000000003",
] as const;
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
  kind: "CLIENT" | "EMPLOYEE";
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
export function parseAllocation(value: unknown): AllocationInput {
  if (!value || typeof value !== "object")
    throw new Error("Expected an allocation object");
  const v = value as Record<string, unknown>;
  if (
    v.sourceAccount !== SOURCE_ACCOUNT ||
    !EMPLOYEE_ACCOUNTS.includes(
      v.targetAccount as (typeof EMPLOYEE_ACCOUNTS)[number],
    )
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
    sourceAccount: v.sourceAccount,
    targetAccount: v.targetAccount as string,
    amountMinor: v.amountMinor,
    currency: "ZAR",
  };
}
