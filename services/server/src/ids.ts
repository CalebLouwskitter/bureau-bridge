import { createHash } from "node:crypto";
import type { AllocationInput } from "@bureau/contracts";

// The idempotency fingerprint is the canonical request payload. Key order is
// fixed here so every creation path compares the same text.
export const fingerprint = (input: AllocationInput) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        sourceAccount: input.sourceAccount,
        targetAccount: input.targetAccount,
        amountMinor: input.amountMinor,
        currency: input.currency,
      }),
    )
    .digest("hex");

// A name-based UUID (version 5 layout over SHA-256). The same purpose and
// subject always give the same key, so reprocessing cannot create a second
// business request.
export function deriveUuid(purpose: string, subject: string) {
  const hex = createHash("sha256")
    .update(`${purpose}:${subject}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const returnKey = (payoutId: string) =>
  deriveUuid("bank-return", payoutId);

export interface PayoutApprovalItem {
  id: string;
  amountMinor: number;
  branch: string;
  bankAccount: string;
}

/**
 * Cryptographic SHA-256 approval hash over payout instruction identity, amount,
 * and beneficiary bank account. Fails maker-checker approval if mutated.
 */
export function payoutInstructionApprovalHash(
  item: PayoutApprovalItem,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: item.id,
        amountMinor: item.amountMinor,
        branch: item.branch,
        bankAccount: item.bankAccount,
      }),
    )
    .digest("hex");
}

export function payoutFileApprovalHash(
  items: ReadonlyArray<PayoutApprovalItem>,
): string {
  const canonical = [...items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((i) => ({
      id: i.id,
      amountMinor: i.amountMinor,
      branch: i.branch,
      bankAccount: i.bankAccount,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
