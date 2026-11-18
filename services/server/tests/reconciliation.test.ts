import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BANK_DETAILS,
  payoutStatus,
  SETTLEMENT_ACCOUNT,
  type Allocation,
  type Payout,
  type ReconciliationRun,
} from "@bureau/contracts";
import type { Legacy, LegacyInventory, LegacyResult } from "../src/legacy.ts";
import {
  classifyVariance,
  compare,
  reportCsv,
  summarizeVariances,
} from "../src/reconciliation.ts";
import { PostBatchReconciliationRunner } from "../src/reconciliation-runner.ts";
import { buildEft, buildResponse, sha256, USER_CODE } from "../src/eft.ts";
import { MemoryStore } from "../src/store.ts";
import type { StoredBankResponse, StoredPayoutFile } from "../src/payouts.ts";

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

test("three-way reconciliation classifies timing gaps, unmatched legs, and amount/hash mismatches across SQL, COBOL, and BankResponses", () => {
  const fundingId = randomUUID();
  const payoutId = randomUUID();
  const fileId = randomUUID();
  const bankInfo = BANK_DETAILS.EMP000000001;

  const eftContent = buildEft({
    userCode: USER_CODE,
    fileId,
    generation: 1,
    actionDate: "2026-10-21",
    items: [
      {
        reference: payoutId,
        branch: bankInfo.branch,
        account: bankInfo.account,
        amountMinor: 10_000,
        holder: bankInfo.holder,
      },
    ],
  });
  const respContent = buildResponse({
    fileId,
    generation: 1,
    status: "ACCEPTED",
    reason: null,
    results: [{ reference: payoutId, outcome: "PAID", code: null }],
  });

  const makeRecords = (): {
    modern: Allocation[];
    inventory: LegacyInventory;
    payout: Payout;
    file: StoredPayoutFile;
    bankResponse: StoredBankResponse;
  } => {
    const now = new Date().toISOString();
    const funding: Allocation = {
      id: fundingId,
      clientId: "INSURER_DEMO",
      sourceAccount: "INS000000001",
      targetAccount: "EMP000000001",
      amountMinor: 25_000,
      currency: "ZAR",
      status: "POSTED",
      reason: "OK",
      postingId: fundingId,
      createdAt: now,
      updatedAt: now,
    };
    const debit: Allocation = {
      id: payoutId,
      clientId: "INSURER_DEMO",
      sourceAccount: "EMP000000001",
      targetAccount: SETTLEMENT_ACCOUNT,
      amountMinor: 10_000,
      currency: "ZAR",
      status: "POSTED",
      reason: "OK",
      postingId: payoutId,
      createdAt: now,
      updatedAt: now,
    };
    const coreRows: LegacyResult[] = [funding, debit].map((x) => ({
      ...x,
      reference: x.id,
    }));
    const inv: LegacyInventory = {
      requests: coreRows.map((x) => ({ ...x })),
      batches: [],
      truncated: false,
      core: {
        records: coreRows,
        generation: "gen-3way",
        observedAt: now,
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
            amountMinor: 15_000,
            currency: "ZAR",
            kind: "EMPLOYEE",
            state: "ACTIVE",
          },
          {
            account: SETTLEMENT_ACCOUNT,
            amountMinor: 10_000,
            currency: "ZAR",
            kind: "SETTLEMENT",
            state: "ACTIVE",
          },
        ],
      },
    };
    const pBase = {
      id: payoutId,
      clientId: "INSURER_DEMO",
      employeeAccount: "EMP000000001",
      amountMinor: 10_000,
      currency: "ZAR" as const,
      branch: bankInfo.branch,
      bankAccount: bankInfo.account,
      holder: bankInfo.holder,
      debitStatus: "POSTED" as const,
      fileId,
      bankOutcome: "PAID" as const,
      returnCode: null,
      returnAllocationId: null,
      returnStatus: null,
      createdAt: now,
    };
    const p: Payout = { ...pBase, status: payoutStatus(pBase) };
    const file: StoredPayoutFile = {
      id: fileId,
      clientId: "INSURER_DEMO",
      generation: 1,
      actionDate: "2026-10-21",
      itemCount: 1,
      amountTotal: 10_000,
      hashTotal: Number(BigInt(bankInfo.account)),
      sha256: sha256(eftContent),
      status: "RESPONSE_PROCESSED",
      createdAt: now,
      content: eftContent,
    };
    const bankResponse: StoredBankResponse = {
      payoutFileId: fileId,
      sha256: sha256(respContent),
      status: "ACCEPTED",
      content: respContent,
      receivedAt: now,
    };
    return {
      modern: [funding, debit],
      inventory: inv,
      payout: p,
      file,
      bankResponse,
    };
  };

  // 1. Clean three-way match
  const cleanCase = makeRecords();
  const cleanFindings = compare(
    cleanCase.modern,
    cleanCase.inventory,
    Date.now(),
    false,
    {
      payouts: [cleanCase.payout],
      files: [cleanCase.file],
      bankResponses: [cleanCase.bankResponse],
      truncated: false,
    },
  );
  const cleanSummary = summarizeVariances(cleanFindings);
  assert.equal(cleanSummary.clean, true);
  assert.equal(cleanSummary.highSeverity, 0);

  // 2. Timing gap: submitted file awaiting bank response
  const timingCase = makeRecords();
  timingCase.file.status = "SUBMITTED";
  timingCase.payout.bankOutcome = null;
  const timingFindings = compare(
    timingCase.modern,
    timingCase.inventory,
    Date.now(),
    false,
    {
      payouts: [timingCase.payout],
      files: [timingCase.file],
      bankResponses: [],
      truncated: false,
    },
  );
  assert.ok(
    timingFindings.some(
      (f) => f.code === "BANK_RESPONSE_PENDING" && f.category === "TIMING_GAP",
    ),
  );
  assert.equal(summarizeVariances(timingFindings).timingGaps, 1);

  // 3. Unmatched leg: file marked RESPONSE_PROCESSED without stored bank response
  const unmatchedCase = makeRecords();
  const unmatchedFindings = compare(
    unmatchedCase.modern,
    unmatchedCase.inventory,
    Date.now(),
    false,
    {
      payouts: [unmatchedCase.payout],
      files: [unmatchedCase.file],
      bankResponses: [],
      truncated: false,
    },
  );
  assert.ok(
    unmatchedFindings.some(
      (f) =>
        f.code === "FILE_PROCESSED_WITHOUT_BANK_RESPONSE" &&
        f.category === "UNMATCHED_LEG",
    ),
  );
  assert.ok(
    unmatchedFindings.some(
      (f) =>
        f.code === "THREE_WAY_TOTAL_MISMATCH" &&
        f.category === "AMOUNT_OR_HASH_MISMATCH",
    ),
  );

  // 4. Hash mismatch on stored bank response
  const hashCase = makeRecords();
  hashCase.bankResponse.sha256 = "0".repeat(64);
  const hashFindings = compare(
    hashCase.modern,
    hashCase.inventory,
    Date.now(),
    false,
    {
      payouts: [hashCase.payout],
      files: [hashCase.file],
      bankResponses: [hashCase.bankResponse],
      truncated: false,
    },
  );
  assert.ok(
    hashFindings.some(
      (f) =>
        f.code === "BANK_RESPONSE_HASH_MISMATCH" &&
        f.category === "AMOUNT_OR_HASH_MISMATCH",
    ),
  );
  assert.equal(classifyVariance("MODERN_IMPORT_PENDING"), "TIMING_GAP");
  assert.equal(classifyVariance("CORE_WITHOUT_INTAKE"), "UNMATCHED_LEG");
  assert.equal(
    classifyVariance("PAYOUT_FILE_ALTERED"),
    "AMOUNT_OR_HASH_MISMATCH",
  );
});

test("PostBatchReconciliationRunner triggers immediately on new COBOL batch generation and on schedule", async () => {
  let now = 1_700_000_000_000;
  let currentGen = "gen-001";
  const store = new MemoryStore(() => now);
  const logs: Record<string, unknown>[] = [];
  const legacy: Legacy = {
    lookup: async () => undefined,
    submit: async () => {
      throw new Error("unused");
    },
    inquire: async () => ({}),
    retryUnposted: async () => ({}),
    accounts: async () => ({
      generation: currentGen,
      sequence: 1,
      observedAt: new Date(now).toISOString(),
      balances: [],
    }),
    inventory: async () => ({
      requests: [],
      batches: [],
      truncated: false,
      core: {
        records: [],
        balances: [
          {
            account: "INS000000001",
            amountMinor: 10_000_000,
            currency: "ZAR",
            kind: "CLIENT",
            state: "ACTIVE",
          },
        ],
        generation: currentGen,
        observedAt: new Date(now).toISOString(),
        truncated: false,
      },
    }),
  };

  const runner = new PostBatchReconciliationRunner(
    store,
    legacy,
    "INSURER_DEMO",
    {
      intervalMs: 300_000,
      now: () => now,
      log: (entry) => logs.push(entry),
    },
  );

  // First run executes on initial schedule
  const r1 = await runner.runIfNeeded(currentGen);
  assert.equal(r1.ran, true);
  assert.equal(r1.trigger, "scheduled");
  assert.equal(r1.summary?.clean, true);

  // Same generation before 300s -> skipped
  now += 10_000;
  const r2 = await runner.runIfNeeded(currentGen);
  assert.equal(r2.ran, false);

  // New COBOL batch generation observed -> triggers immediate post-batch reconciliation!
  currentGen = "gen-002";
  now += 5_000;
  const r3 = await runner.runIfNeeded(currentGen);
  assert.equal(r3.ran, true);
  assert.equal(r3.trigger, "post_batch");
  assert.equal(r3.run?.generation, "gen-002");

  // Scheduled fallback after interval elapses
  now += 300_000;
  const r4 = await runner.runIfNeeded(currentGen);
  assert.equal(r4.ran, true);
  assert.equal(r4.trigger, "scheduled");

  assert.equal(logs.length, 3);
  assert.equal(typeof logs[1].traceId, "string");
  assert.equal(logs[1].trigger, "post_batch");
});
