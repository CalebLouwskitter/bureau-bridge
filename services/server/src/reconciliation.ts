import { randomUUID } from "node:crypto";
import {
  SOURCE_ACCOUNT,
  EMPLOYEE_ACCOUNTS,
  type Allocation,
  type ReconciliationFinding,
  type ReconciliationRun,
} from "@bureau/contracts";
import type { Legacy, LegacyInventory, LegacyResult } from "./legacy.ts";
import type { Store } from "./store.ts";

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
  return findings;
}

export async function reconcile(
  store: Store,
  legacy: Legacy,
  clientId: string,
): Promise<ReconciliationRun> {
  const [modern, inventory] = await Promise.all([
    store.scan(clientId),
    legacy.inventory(),
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
      modern.truncated || inventory.truncated || inventory.core.truncated,
    findings: compare(
      modern.allocations,
      inventory,
      Date.now(),
      modern.truncated,
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
