import { randomUUID } from "node:crypto";
import {
  SOURCE_ACCOUNT,
  EMPLOYEE_ACCOUNTS,
  SETTLEMENT_ACCOUNT,
  type Allocation,
  type Payout,
  type ReconciliationFinding,
  type ReconciliationRun,
  type VarianceCategory,
} from "@bureau/contracts";
import type { Legacy, LegacyInventory, LegacyResult } from "./legacy.ts";
import type { Store } from "./store.ts";
import {
  parseAnyBankResponse,
  parseAnyPaymentFile,
  sha256,
} from "./eft.ts";
import type {
  PayoutStore,
  StoredBankResponse,
  StoredPayoutFile,
} from "./payouts.ts";

const TIMING_GAP_CODES = new Set([
  "MODERN_IMPORT_PENDING",
  "LEGACY_IMPORT_PENDING",
  "RETURN_CREDIT_PENDING",
  "PAYOUT_AWAITING_FILE",
  "BANK_SUBMISSION_UNKNOWN",
  "BANK_RESPONSE_PENDING",
  "SCAN_INCOMPLETE",
]);

const UNMATCHED_LEG_CODES = new Set([
  "INTAKE_MISSING",
  "MODERN_FINAL_WITHOUT_CORE",
  "LEGACY_FINAL_WITHOUT_CORE",
  "CORE_WITHOUT_INTAKE",
  "PAYOUT_FILED_WITHOUT_DEBIT",
  "SETTLEMENT_POSTING_OUTSIDE_HUB",
  "BANK_RESPONSE_WITHOUT_FILE",
  "FILE_PROCESSED_WITHOUT_BANK_RESPONSE",
  "BANK_RESPONSE_UNMATCHED_ITEM",
  "UNKNOWN_CORE_ACCOUNT",
]);

const AMOUNT_OR_HASH_MISMATCH_CODES = new Set([
  "MODERN_INTAKE_PAYLOAD",
  "MODERN_CORE_PAYLOAD",
  "INTAKE_CORE_PAYLOAD",
  "MODERN_CORE_OUTCOME",
  "INTAKE_CORE_OUTCOME",
  "INVALID_CORE_OUTCOME",
  "DUPLICATE_REFERENCE",
  "BATCH_CONTROL_MISMATCH",
  "JOURNAL_BALANCE_MISMATCH",
  "SETTLEMENT_BREAK",
  "PAYOUT_FILE_ALTERED",
  "PAYOUT_FILE_CONTROL_MISMATCH",
  "BANK_RESPONSE_HASH_MISMATCH",
  "BANK_RESPONSE_PARSE_ERROR",
  "BANK_RESPONSE_OUTCOME_MISMATCH",
  "THREE_WAY_TOTAL_MISMATCH",
]);

export function classifyVariance(code: string): VarianceCategory {
  if (TIMING_GAP_CODES.has(code)) return "TIMING_GAP";
  if (UNMATCHED_LEG_CODES.has(code)) return "UNMATCHED_LEG";
  if (AMOUNT_OR_HASH_MISMATCH_CODES.has(code)) return "AMOUNT_OR_HASH_MISMATCH";
  return "INFO";
}

export interface VarianceSummary {
  timingGaps: number;
  unmatchedLegs: number;
  amountOrHashMismatches: number;
  info: number;
  highSeverity: number;
  clean: boolean;
}

export function summarizeVariances(
  findings: readonly ReconciliationFinding[],
): VarianceSummary {
  let timingGaps = 0;
  let unmatchedLegs = 0;
  let amountOrHashMismatches = 0;
  let info = 0;
  let highSeverity = 0;
  for (const f of findings) {
    if (f.severity === "HIGH") highSeverity++;
    const cat = f.category ?? classifyVariance(f.code);
    if (cat === "TIMING_GAP") timingGaps++;
    else if (cat === "UNMATCHED_LEG") unmatchedLegs++;
    else if (cat === "AMOUNT_OR_HASH_MISMATCH") amountOrHashMismatches++;
    else info++;
  }
  return {
    timingGaps,
    unmatchedLegs,
    amountOrHashMismatches,
    info,
    highSeverity,
    clean: highSeverity === 0,
  };
}

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
  ) =>
    findings.push({
      severity,
      code,
      category: classifyVariance(code),
      reference,
      details,
    });
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
  bankResponses?: StoredBankResponse[];
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
      lines = new Map(
        parseAnyPaymentFile(f.content).items.map((i) => [i.reference, i]),
      );
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
  const filesById = new Map(scan.files.map((f) => [f.id, f]));
  if (scan.bankResponses !== undefined) {
    const responsesByFileId = new Map<string, StoredBankResponse>();
    for (const br of scan.bankResponses) {
      responsesByFileId.set(br.payoutFileId, br);
      const file = filesById.get(br.payoutFileId);
      if (!file) {
        add(
          "HIGH",
          "BANK_RESPONSE_WITHOUT_FILE",
          br.payoutFileId,
          `Imported bank response references unknown payout file ${br.payoutFileId}.`,
        );
      }
      if (sha256(br.content) !== br.sha256) {
        add(
          "HIGH",
          "BANK_RESPONSE_HASH_MISMATCH",
          br.payoutFileId,
          `Imported bank response for file ${br.payoutFileId} does not match its recorded SHA-256 hash.`,
        );
      }
      let parsedResp;
      try {
        parsedResp = parseAnyBankResponse(br.content);
      } catch {
        add(
          "HIGH",
          "BANK_RESPONSE_PARSE_ERROR",
          br.payoutFileId,
          `Imported bank response for file ${br.payoutFileId} could not be parsed.`,
        );
        continue;
      }
      if (
        parsedResp.fileId !== br.payoutFileId ||
        parsedResp.status !== br.status ||
        (file && parsedResp.generation !== file.generation)
      ) {
        add(
          "HIGH",
          "BANK_RESPONSE_OUTCOME_MISMATCH",
          br.payoutFileId,
          `Imported bank response header disagrees with payout file ${br.payoutFileId}.`,
        );
      }
      if (parsedResp.status === "ACCEPTED") {
        const members = byFile.get(br.payoutFileId) ?? [];
        const membersById = new Map(members.map((m) => [m.id, m]));
        const seenInBank = new Set<string>();
        for (const r of parsedResp.results) {
          seenInBank.add(r.reference);
          const inst = membersById.get(r.reference);
          if (!inst) {
            add(
              "HIGH",
              "BANK_RESPONSE_UNMATCHED_ITEM",
              r.reference,
              `Bank response for file ${br.payoutFileId} reports an item with no matching payout instruction.`,
            );
            continue;
          }
          if (inst.bankOutcome !== r.outcome || inst.returnCode !== r.code) {
            add(
              "HIGH",
              "BANK_RESPONSE_OUTCOME_MISMATCH",
              r.reference,
              `Bank response reports ${r.outcome}${r.code ? ` (${r.code})` : ""} while payout instruction records ${inst.bankOutcome ?? "none"}.`,
            );
          }
        }
        for (const inst of members) {
          if (!seenInBank.has(inst.id)) {
            add(
              "HIGH",
              "BANK_RESPONSE_UNMATCHED_ITEM",
              inst.id,
              `Payout instruction in file ${br.payoutFileId} is absent from the imported bank response.`,
            );
          }
        }
      }
    }
    for (const f of scan.files) {
      if (f.status === "SUBMITTED" && !responsesByFileId.has(f.id)) {
        add(
          "WARN",
          "BANK_RESPONSE_PENDING",
          f.id,
          `File generation ${f.generation} has been submitted and is awaiting an imported bank response.`,
        );
      }
      if (
        (f.status === "RESPONSE_PROCESSED" || f.status === "REJECTED") &&
        !responsesByFileId.has(f.id)
      ) {
        add(
          "HIGH",
          "FILE_PROCESSED_WITHOUT_BANK_RESPONSE",
          f.id,
          `File generation ${f.generation} is marked ${f.status} without a stored bank response record.`,
        );
      }
    }
  }
  if (incomplete) return;
  if (scan.bankResponses !== undefined) {
    // Compare three-way payout leg totals: SQL Server PayoutInstructions vs COBOL posted debits vs Bank-confirmed + in-flight
    let sqlPostedDebitTotal = 0;
    let corePostedDebitTotal = 0;
    let bankConfirmedPaidTotal = 0;
    for (const p of scan.payouts) {
      if (p.debitStatus === "POSTED") sqlPostedDebitTotal += p.amountMinor;
      const c = core.get(p.id);
      if (c && c.status === "POSTED") corePostedDebitTotal += c.amountMinor;
    }
    const payoutById = new Map(scan.payouts.map((p) => [p.id, p]));
    for (const br of scan.bankResponses) {
      if (br.status !== "ACCEPTED") continue;
      try {
        const parsedResp = parseAnyBankResponse(br.content);
        for (const r of parsedResp.results) {
          const inst = payoutById.get(r.reference);
          if (inst && r.outcome === "PAID") {
            bankConfirmedPaidTotal += inst.amountMinor;
          }
        }
      } catch {
        // Already flagged via BANK_RESPONSE_PARSE_ERROR
      }
    }
    if (
      sqlPostedDebitTotal !== corePostedDebitTotal ||
      bankConfirmedPaidTotal !== bucket.paid
    ) {
      add(
        "HIGH",
        "THREE_WAY_TOTAL_MISMATCH",
        null,
        `Three-way payout totals disagree: SQL debits ${rand(sqlPostedDebitTotal)}, COBOL journal debits ${rand(corePostedDebitTotal)}, bank-confirmed paid ${rand(bankConfirmedPaidTotal)} vs instruction paid ${rand(bucket.paid)}.`,
      );
    }
  }
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
  traceparent?: string | null,
): Promise<ReconciliationRun> {
  const [modern, inventory, payouts] = await Promise.all([
    store.scan(clientId),
    legacy.inventory(traceparent ? { traceparent } : undefined),
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
    "category",
    "code",
    "reference",
    "details",
  ];
  const findings = run.findings.length
    ? run.findings
    : [
        {
          severity: "INFO" as const,
          category: "INFO" as const,
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
        f.category ?? classifyVariance(f.code),
        f.code,
        f.reference,
        f.details,
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n") + "\r\n"
  );
}
