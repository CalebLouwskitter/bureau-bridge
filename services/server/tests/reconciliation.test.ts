import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Allocation, ReconciliationRun } from "@bureau/contracts";
import type { LegacyInventory } from "../src/legacy.ts";
import { compare, reportCsv } from "../src/reconciliation.ts";

function fixture() {
  const a: Allocation = {
    id: randomUUID(),
    clientId: "INSURER_DEMO",
    sourceAccount: "INS000000001",
    targetAccount: "EMP000000001",
    amountMinor: 25000,
    currency: "ZAR",
    status: "POSTED",
    reason: "OK",
    postingId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  a.postingId = a.id;
  const r = { ...a, reference: a.id };
  const inventory: LegacyInventory = {
    requests: [{ ...r }],
    batches: [],
    truncated: false,
    core: {
      records: [{ ...r }],
      generation: "gen-test",
      observedAt: new Date().toISOString(),
      truncated: false,
      balances: [
        {
          account: "INS000000001",
          amountMinor: 9_975_000,
          currency: "ZAR",
          kind: "CLIENT",
          state: "ACTIVE",
        },
        {
          account: "EMP000000001",
          amountMinor: 25_000,
          currency: "ZAR",
          kind: "EMPLOYEE",
          state: "ACTIVE",
        },
      ],
    },
  };
  return { a, inventory };
}
test("a matched posting reconciles payload, outcome, and seed-plus-journal balances", () => {
  const f = fixture();
  assert.deepEqual(compare([f.a], f.inventory), []);
});
test("a lost result exposes import lag in both legacy and modern projections", () => {
  const f = fixture();
  f.a.status = "VERIFYING";
  f.inventory.requests[0].status = "VERIFYING";
  const codes = compare([f.a], f.inventory).map((f) => f.code);
  assert.ok(codes.includes("MODERN_IMPORT_PENDING"));
  assert.ok(codes.includes("LEGACY_IMPORT_PENDING"));
});
test("payload drift, false final outcomes, and incorrect balances produce high-severity evidence", () => {
  const f = fixture();
  f.inventory.requests[0].amountMinor = 25001;
  f.inventory.core.balances[0].amountMinor -= 1;
  const findings = compare([f.a], f.inventory);
  assert.ok(
    findings.some(
      (f) => f.code === "MODERN_INTAKE_PAYLOAD" && f.severity === "HIGH",
    ),
  );
  assert.ok(
    findings.some(
      (f) => f.code === "JOURNAL_BALANCE_MISMATCH" && f.severity === "HIGH",
    ),
  );
  f.inventory.core.records = [];
  assert.ok(
    compare([f.a], f.inventory).some(
      (f) => f.code === "MODERN_FINAL_WITHOUT_CORE",
    ),
  );
});
test("portal-origin work is informational, fresh queued work is normal, and incomplete scans cannot claim a clean match", () => {
  const f = fixture();
  assert.equal(compare([], f.inventory)[0].code, "LEGACY_ONLY");
  f.a.status = "QUEUED";
  f.inventory.requests = [];
  f.inventory.core.records = [];
  f.inventory.core.balances[0].amountMinor = 10_000_000;
  f.inventory.core.balances[1].amountMinor = 0;
  assert.deepEqual(compare([f.a], f.inventory), []);
  f.a.status = "POSTED";
  f.inventory.truncated = true;
  const codes = compare([f.a], f.inventory).map((f) => f.code);
  assert.ok(codes.includes("SCAN_INCOMPLETE"));
  assert.ok(!codes.includes("MODERN_FINAL_WITHOUT_CORE"));
});
test("batch control mismatches are findings and exported text cannot become a spreadsheet formula", () => {
  const f = fixture();
  f.inventory.batches = [
    {
      id: randomUUID(),
      control_match: false,
      unresolved_count: 0,
      record_count: 2,
      amount_total: 50000,
      submitted_count: 1,
      submitted_total: 25000,
    },
  ];
  assert.ok(
    compare([f.a], f.inventory).some(
      (f) => f.code === "BATCH_CONTROL_MISMATCH",
    ),
  );
  const run: ReconciliationRun = {
    id: randomUUID(),
    clientId: "INSURER_DEMO",
    createdAt: new Date().toISOString(),
    generation: "gen-test",
    observedAt: new Date().toISOString(),
    modernCount: 1,
    intakeCount: 1,
    coreCount: 1,
    truncated: false,
    findings: [
      { severity: "HIGH", code: "TEST", reference: null, details: "=1+1" },
    ],
  };
  assert.match(reportCsv(run), /"'=1\+1"/);
});
