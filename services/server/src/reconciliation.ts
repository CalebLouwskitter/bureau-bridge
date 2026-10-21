import { randomUUID } from "node:crypto";
import {
  SOURCE_ACCOUNT,
  EMPLOYEE_ACCOUNTS,
  SETTLEMENT_ACCOUNT,
  type Allocation,
  type Payout,
  type ReconciliationFinding,
  type ReconciliationRun,
} from "@bureau/contracts";
import type { Legacy, LegacyInventory, LegacyResult } from "./legacy.ts";
import type { Store } from "./store.ts";
import { parseEft, sha256 } from "./eft.ts";
import type { PayoutStore, StoredPayoutFile } from "./payouts.ts";

const final = (status: string) => ["POSTED", "DECLINED"].includes(status);
const payloadMatches = (
  a: Allocation | LegacyResult,
  b: Allocation | LegacyResult,
) =>
  a.sourceAccount === b.sourceAccount &&
  a.targetAccount === b.targetAccount &&
  a.amountMinor === b.amountMinor &&
  a.currency === b.currency;

// Findings describe a captured observation. Recovery remains an explicit inquiry.
export function compare(
  modern: Allocation[],
  legacy: LegacyInventory,
  now = Date.now(),
  modernTruncated = false,
  payouts?: PayoutScan,
): ReconciliationFinding[] {
  const findings: ReconciliationFinding[] = [];
  const add = (
    severity: ReconciliationFinding["severity"],
    code: string,
    reference: string | null,
    details: string,
  ) => findings.push({ severity, code, reference, details });
  const incomplete =
    modernTruncated || legacy.truncated || legacy.core.truncated;
  if (incomplete)
    add(
      "WARN",
      "SCAN_INCOMPLETE",
      null,
      "The 5000-record demo limit was reached. Missing-reference and balance checks are suppressed; this run cannot establish a clean reconciliation.",
    );
  const index = (rows: LegacyResult[], layer: string) => {
    const refs = new Map<string, LegacyResult>();
    for (const row of rows) {
      if (refs.has(row.reference))
        add(
          "HIGH",
          "DUPLICATE_REFERENCE",
          row.reference,
          `${layer} contains a repeated reference.`,
        );
      refs.set(row.reference, row);
    }
    return refs;
  };
  const intake = index(legacy.requests, "Legacy intake");
  const core = index(legacy.core.records, "Core journal");
  const modernIds = new Set(modern.map((a) => a.id));
  for (const a of modern) {
    const r = intake.get(a.id),
      c = core.get(a.id);
    if (
      !r &&
      !incomplete &&
      (final(a.status) || now - Date.parse(a.createdAt) > 60_000)
    )
      add(
        final(a.status) ? "HIGH" : "WARN",
        "INTAKE_MISSING",
        a.id,
        "The modern request is absent from the captured legacy register.",
      );
    if (r && !payloadMatches(a, r))
      add(
        "HIGH",
        "MODERN_INTAKE_PAYLOAD",
        a.id,
        "Modern and legacy request data differ.",
      );
    if (c && !payloadMatches(a, c))
      add(
        "HIGH",
        "MODERN_CORE_PAYLOAD",
        a.id,
        "Modern request data differ from the authoritative journal.",
      );
    if (
      c &&
      final(a.status) &&
      (a.status !== c.status || a.postingId !== c.postingId)
    )
      add(
        "HIGH",
        "MODERN_CORE_OUTCOME",
        a.id,
        "The final modern outcome or posting reference differs from the core.",
      );
    if (c && !final(a.status))
      add(
        "WARN",
        "MODERN_IMPORT_PENDING",
        a.id,
        "The core has a final outcome; the modern projection has not recorded it yet.",
      );
    if (!c && final(a.status) && !incomplete)
      add(
        "HIGH",
        "MODERN_FINAL_WITHOUT_CORE",
        a.id,
        "The modern system claims a final outcome without a matching core journal entry.",
      );
  }
  for (const r of intake.values()) {
    const c = core.get(r.reference);
    if (!modernIds.has(r.reference) && !modernTruncated)
      add(
        "INFO",
        "LEGACY_ONLY",
        r.reference,
        "Entered through the PHP portal; no modern-origin request exists.",
      );
    if (c && !payloadMatches(r, c))
      add(
        "HIGH",
        "INTAKE_CORE_PAYLOAD",
        r.reference,
        "Legacy intake data differ from the authoritative journal.",
      );
    if (
      c &&
      final(r.status) &&
      (r.status !== c.status || r.postingId !== c.postingId)
    )
      add(
        "HIGH",
        "INTAKE_CORE_OUTCOME",
        r.reference,
        "The final legacy outcome or posting reference differs from the core.",
      );
    if (c && !final(r.status))
      add(
        "WARN",
        "LEGACY_IMPORT_PENDING",
        r.reference,
        "A core outcome exists but legacy result import is unresolved. Run a core inquiry.",
      );
    if (!c && final(r.status) && !incomplete)
      add(
        "HIGH",
        "LEGACY_FINAL_WITHOUT_CORE",
        r.reference,
        "Legacy intake claims a final outcome without a matching core journal entry.",
      );
  }
  for (const c of core.values()) {
    if (!intake.has(c.reference) && !incomplete)
      add(
        "HIGH",
        "CORE_WITHOUT_INTAKE",
        c.reference,
        "The authoritative journal has no matching captured intake request.",
      );
    if (
      !final(c.status) ||
      (c.status === "POSTED" && c.postingId !== c.reference) ||
      (c.status === "DECLINED" && c.postingId !== null)
    )
      add(
        "HIGH",
        "INVALID_CORE_OUTCOME",
        c.reference,
        "The core journal outcome violates the posting-reference contract.",
      );
  }
  for (const b of legacy.batches)
    if (!b.control_match)
      add(
        "HIGH",
        "BATCH_CONTROL_MISMATCH",
        null,
        `Batch ${b.id}: manifest ${b.record_count} records / ${b.amount_total} cents; membership ${b.submitted_count} records / ${b.submitted_total} cents.`,
      );
  if (!incomplete) {
    const expected = new Map<string, number>([
      [SOURCE_ACCOUNT, 10_000_000],
      ...EMPLOYEE_ACCOUNTS.map((a) => [a, 0] as [string, number]),
      [SETTLEMENT_ACCOUNT, 0],
    ]);
    for (const c of core.values())
      if (c.status === "POSTED") {
        expected.set(
          c.sourceAccount,
          (expected.get(c.sourceAccount) ?? 0) - c.amountMinor,
        );
        expected.set(
          c.targetAccount,
          (expected.get(c.targetAccount) ?? 0) + c.amountMinor,
        );
      }
    const actual = new Map(
      legacy.core.balances.map((a) => [a.account, a.amountMinor]),
    );
    for (const [account, cents] of expected)
      if ((actual.get(account) ?? 0) !== cents)
        add(
          "HIGH",
          "JOURNAL_BALANCE_MISMATCH",
          null,
          `${account}: seed plus journal gives ${cents} cents; snapshot gives ${actual.get(account) ?? "missing"}.`,
        );
    for (const account of actual.keys())
      if (!expected.has(account))
        add(
          "HIGH",
          "UNKNOWN_CORE_ACCOUNT",
          null,
          `Snapshot contains unexpected account ${account}.`,
        );
  }
  if (payouts)
    comparePayouts(payouts, legacy, add, incomplete || payouts.truncated);
  return findings;
}

const rand = (minor: number) => `R${(minor / 100).toFixed(2)}`;
export interface PayoutScan {
  payouts: Payout[];
  files: StoredPayoutFile[];
  truncated: boolean;
}
// The payout leg's break report. Settlement holds value that left by EFT or
// is on its way; every cent in it must be explained by a payout instruction.
function comparePayouts(
  scan: PayoutScan,
  legacy: LegacyInventory,
  add: (
    severity: ReconciliationFinding["severity"],
    code: string,
    reference: string | null,
    details: string,
  ) => void,
  incomplete: boolean,
) {
  const core = new Map(legacy.core.records.map((r) => [r.reference, r]));
  const posted = (reference: string | null) =>
    reference !== null && core.get(reference)?.status === "POSTED";
  const hub = new Set<string>(),
    byFile = new Map<string, Payout[]>();
  const bucket = { paid: 0, inFile: 0, awaitingFile: 0, returnPending: 0 };
  let explained = 0;
  for (const p of scan.payouts) {
    hub.add(p.id);
    if (p.returnAllocationId) hub.add(p.returnAllocationId);
    if (p.fileId) byFile.set(p.fileId, [...(byFile.get(p.fileId) ?? []), p]);
    if (p.fileId && !posted(p.id))
      add(
        "HIGH",
        "PAYOUT_FILED_WITHOUT_DEBIT",
        p.id,
        "A bank file pays this instruction, but the core has no posted debit for it.",
      );
    if (!posted(p.id) || posted(p.returnAllocationId)) continue;
    explained += p.amountMinor;
    if (p.bankOutcome === "RETURNED") {
      bucket.returnPending += p.amountMinor;
      add(
        "WARN",
        "RETURN_CREDIT_PENDING",
        p.id,
        `The bank returned this payout (${p.returnCode}); the employee credit has not posted in the core yet.`,
      );
    } else if (p.bankOutcome === "PAID") bucket.paid += p.amountMinor;
    else if (p.fileId) bucket.inFile += p.amountMinor;
    else {
      bucket.awaitingFile += p.amountMinor;
      add(
        "INFO",
        "PAYOUT_AWAITING_FILE",
        p.id,
        "Debited in the core; not yet in a bank file.",
      );
    }
  }
  for (const f of scan.files) {
    if (f.status === "SUBMISSION_UNKNOWN")
      add(
        "WARN",
        "BANK_SUBMISSION_UNKNOWN",
        null,
        `File generation ${f.generation}: the bank outcome is unknown. Submit again; the bank answers a repeat of the same bytes with its original response.`,
      );
    if (sha256(f.content) !== f.sha256)
      add(
        "HIGH",
        "PAYOUT_FILE_ALTERED",
        null,
        `File generation ${f.generation}: stored bytes no longer match the recorded hash.`,
      );
    if (f.status === "REJECTED") continue;
    let lines;
    try {
      lines = new Map(parseEft(f.content).items.map((i) => [i.reference, i]));
    } catch {
      lines = new Map();
    }
    const members = byFile.get(f.id) ?? [];
    if (
      members.length !== lines.size ||
      members.some((m) => lines.get(m.id)?.amountMinor !== m.amountMinor)
    )
      add(
        "HIGH",
        "PAYOUT_FILE_CONTROL_MISMATCH",
        null,
        `File generation ${f.generation}: ${lines.size} valid lines in the file; ${members.length} instructions claim it.`,
      );
  }
  if (incomplete) return;
  for (const c of core.values())
    if (
      c.status === "POSTED" &&
      [c.sourceAccount, c.targetAccount].includes(SETTLEMENT_ACCOUNT) &&
      !hub.has(c.reference)
    )
      add(
        "HIGH",
        "SETTLEMENT_POSTING_OUTSIDE_HUB",
        c.reference,
        "The settlement account moved without a matching payout instruction.",
      );
  const held =
    legacy.core.balances.find((b) => b.account === SETTLEMENT_ACCOUNT)
      ?.amountMinor ?? 0;
  if (held !== explained)
    add(
      "HIGH",
      "SETTLEMENT_BREAK",
      null,
      `Settlement holds ${rand(held)}; payout instructions explain ${rand(explained)}; unexplained ${rand(held - explained)}.`,
    );
  add(
    "INFO",
    "SETTLEMENT_SUMMARY",
    null,
    `Settlement ${rand(held)}: paid by the bank ${rand(bucket.paid)}, in files awaiting a response ${rand(bucket.inFile)}, debited awaiting a file ${rand(bucket.awaitingFile)}, returned awaiting credit ${rand(bucket.returnPending)}.`,
  );
}

export async function reconcile(
  store: Store,
  legacy: Legacy,
  clientId: string,
  payoutStore?: PayoutStore,
): Promise<ReconciliationRun> {
  const [modern, inventory, payouts] = await Promise.all([
    store.scan(clientId),
    legacy.inventory(),
    payoutStore?.scanPayouts(clientId),
  ]);
  const run: ReconciliationRun = {
    id: randomUUID(),
    clientId,
    createdAt: new Date().toISOString(),
    generation: inventory.core.generation,
    observedAt: inventory.core.observedAt,
    modernCount: modern.allocations.length,
    intakeCount: inventory.requests.length,
    coreCount: inventory.core.records.length,
    truncated:
      modern.truncated ||
      inventory.truncated ||
      inventory.core.truncated ||
      Boolean(payouts?.truncated),
    findings: compare(
      modern.allocations,
      inventory,
      Date.now(),
      modern.truncated,
      payouts,
    ),
  };
  await store.saveReconciliation(run);
  return run;
}
const csvCell = (value: unknown) => {
  let cell = String(value ?? "");
  if (/^[=+@\t\r-]/.test(cell)) cell = "'" + cell;
  return '"' + cell.replaceAll('"', '""') + '"';
};
export function reportCsv(run: ReconciliationRun): string {
  const columns = [
    "runId",
    "createdAt",
    "generation",
    "observedAt",
    "modernCount",
    "intakeCount",
    "coreCount",
    "truncated",
    "severity",
    "code",
    "reference",
    "details",
  ];
  const findings = run.findings.length
    ? run.findings
    : [
        {
          severity: "INFO",
          code: "MATCHED",
          reference: null,
          details: "No discrepancies in this captured observation.",
        },
      ];
  return (
    [
      columns,
      ...findings.map((f) => [
        run.id,
        run.createdAt,
        run.generation,
        run.observedAt,
        run.modernCount,
        run.intakeCount,
        run.coreCount,
        run.truncated,
        f.severity,
        f.code,
        f.reference,
        f.details,
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n") + "\r\n"
  );
}
