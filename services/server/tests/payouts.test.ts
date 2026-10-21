import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BANK_DETAILS,
  parseAllocation,
  parseTransfer,
  payoutStatus,
  routeOf,
  SETTLEMENT_ACCOUNT,
  type Payout,
} from "@bureau/contracts";
import {
  buildEft,
  buildResponse,
  EftError,
  parseEft,
  parseResponse,
  sha256,
  USER_CODE,
  type EftFile,
} from "../src/eft.ts";
import { BankSimulator, MemoryLedger } from "../src/bank-sim.ts";
import { deriveUuid, returnKey } from "../src/ids.ts";
import {
  BankUnavailable,
  submitFile,
  type Bank,
  type PayoutStore,
  type StoredPayoutFile,
} from "../src/payouts.ts";
import { compare } from "../src/reconciliation.ts";
import { makeApp } from "../src/app.ts";
import { issue } from "../src/auth.ts";
import type { LegacyInventory, LegacyResult } from "../src/legacy.ts";

const one = BANK_DETAILS.EMP000000001,
  two = BANK_DETAILS.EMP000000002;
const ids = [randomUUID(), randomUUID()].sort();
function eft(overrides: Partial<EftFile> = {}): EftFile {
  return {
    userCode: USER_CODE,
    fileId: randomUUID(),
    generation: 1,
    actionDate: "2026-10-21",
    items: [
      { reference: ids[0], ...one, account: one.account, amountMinor: 10000 },
      { reference: ids[1], ...two, account: two.account, amountMinor: 30000 },
    ],
    ...overrides,
  };
}
const swap = (content: string, row: number, at: number, value: string) => {
  const rows = content.split("\n");
  rows[row] =
    rows[row].slice(0, at) + value + rows[row].slice(at + value.length);
  return rows.join("\n");
};

test("EFT files are fixed-width, deterministic and carry count, amount and hash totals", () => {
  const file = eft();
  const content = buildEft(file);
  const rows = content.split("\n").slice(0, -1);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.length === 80));
  assert.equal(
    buildEft({ ...file, items: [...file.items].reverse() }),
    content,
    "Item order must not change the bytes",
  );
  const parsed = parseEft(content);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[1].amountMinor, 30000);
  assert.equal(parsed.items[0].holder, "EMPLOYEE ONE");
  assert.equal(parsed.generation, 1);
  assert.equal(parsed.actionDate, "2026-10-21");
});

test("EFT trailers expose a changed amount or a redirected account", () => {
  const content = buildEft(eft());
  const amount = swap(content, 1, 18, "000000020000");
  assert.throws(
    () => parseEft(amount),
    (e: EftError) => e.code === "TRAILER_AMOUNT",
  );
  // Same amounts, different destination: only the account hash total catches it.
  const redirected = swap(content, 1, 7, "10000000099");
  assert.throws(
    () => parseEft(redirected),
    (e: EftError) => e.code === "TRAILER_HASH",
  );
  assert.throws(
    () => buildEft(eft({ items: [eft().items[0], eft().items[0]] })),
    (e: EftError) => e.code === "DUPLICATE_ITEM",
  );
  assert.throws(() => parseEft(content.replace("\n", " \n")), EftError);
});

test("bank responses round-trip and reject unknown return codes", () => {
  const fileId = randomUUID();
  const text = buildResponse({
    fileId,
    generation: 7,
    status: "ACCEPTED",
    reason: null,
    results: [
      { reference: ids[0], outcome: "PAID", code: null },
      { reference: ids[1], outcome: "RETURNED", code: "AC" },
    ],
  });
  const parsed = parseResponse(text);
  assert.equal(parsed.fileId, fileId);
  assert.equal(parsed.results[1].code, "AC");
  assert.throws(
    () => parseResponse(text.replace("RETURNEDAC", "RETURNEDZZ")),
    EftError,
  );
});

test("the bank returns closed accounts, replays identical files and refuses a reused generation", async () => {
  const ledger = new MemoryLedger();
  const bank = new BankSimulator(
    ledger,
    new Set([`${two.branch}/${two.account}`]),
  );
  const content = buildEft(eft());
  const first = parseResponse(await bank.submit(content));
  assert.equal(first.status, "ACCEPTED");
  assert.deepEqual(
    first.results.map((r) => r.outcome),
    ["PAID", "RETURNED"],
  );
  assert.equal(await bank.submit(content), await bank.inquire(USER_CODE, 1));
  assert.equal(ledger.entries.size, 1, "A resend must not be processed again");
  const reused = parseResponse(await bank.submit(buildEft(eft())));
  assert.deepEqual(
    [reused.status, reused.reason],
    ["REJECTED", "DUPLICATE_GENERATION"],
  );
  const tampered = parseResponse(
    await bank.submit(
      swap(buildEft(eft({ generation: 2 })), 1, 18, "000000020000"),
    ),
  );
  assert.deepEqual(
    [tampered.status, tampered.reason],
    ["REJECTED", "TRAILER_AMOUNT"],
  );
  const stranger = parseResponse(
    await bank.submit(buildEft(eft({ generation: 3, userCode: "OTHER001" }))),
  );
  assert.equal(stranger.reason, "UNKNOWN_USER_CODE");
  assert.equal(await bank.inquire(USER_CODE, 2), undefined);
});

function fileStore(content: string, generation = 1) {
  const marks: string[] = [],
    imports: string[] = [];
  const file: StoredPayoutFile = {
    id: parseEft(content).fileId,
    clientId: "INSURER_DEMO",
    generation,
    actionDate: "2026-10-21",
    itemCount: 2,
    amountTotal: 40000,
    hashTotal: 0,
    sha256: sha256(content),
    status: "GENERATED",
    createdAt: new Date().toISOString(),
    content,
  };
  const store = {
    payoutFile: async () => file,
    markSubmission: async (_c: string, _id: string, status: string) => {
      marks.push(status);
    },
    importBankResponse: async (_c: string, response: any, text: string) => {
      imports.push(text);
      return {
        fileId: response.fileId,
        status: "RESPONSE_PROCESSED" as const,
        duplicate: imports.length > 1,
        paid: 1,
        returned: 1,
      };
    },
  } as unknown as PayoutStore;
  return { store, file, marks, imports };
}

test("a lost bank response is recovered by asking for the generation, not by paying twice", async () => {
  const content = buildEft(eft());
  const ledger = new MemoryLedger();
  const sim = new BankSimulator(ledger, new Set());
  let sends = 0,
    dropped = false;
  const bank: Bank = {
    submit: async (text) => {
      sends++;
      await sim.submit(text);
      if (!dropped) {
        dropped = true;
        throw new Error("timeout after the bank processed the file");
      }
      return sim.submit(text);
    },
    inquire: (user, generation) => sim.inquire(user, generation),
  };
  const f = fileStore(content);
  await assert.rejects(
    () => submitFile(f.store, bank, "INSURER_DEMO", f.file.id),
    BankUnavailable,
  );
  assert.deepEqual(f.marks, ["SUBMITTED", "SUBMISSION_UNKNOWN"]);
  const result = await submitFile(f.store, bank, "INSURER_DEMO", f.file.id);
  assert.equal(result.duplicate, false);
  assert.equal(sends, 1, "Recovery must use inquiry, not a second send");
  assert.equal(f.imports.length, 1);
  assert.equal(ledger.entries.size, 1);
});

test("an unanswered bank inquiry never authorizes a submission", async () => {
  const f = fileStore(buildEft(eft()));
  const bank: Bank = {
    submit: async () =>
      assert.fail("Must not send while the outcome is unknown"),
    inquire: async () => {
      throw new Error("bank unreachable");
    },
  };
  await assert.rejects(
    () => submitFile(f.store, bank, "INSURER_DEMO", f.file.id),
    BankUnavailable,
  );
  assert.deepEqual(f.marks, []);
});

test("payout routes are only available to the payments hub; derived return keys are stable", () => {
  const payout = {
    sourceAccount: "EMP000000001",
    targetAccount: SETTLEMENT_ACCOUNT,
    amountMinor: 100,
    currency: "ZAR",
  };
  assert.equal(routeOf(payout), "PAYOUT");
  assert.equal(
    routeOf({
      sourceAccount: SETTLEMENT_ACCOUNT,
      targetAccount: "EMP000000002",
    }),
    "RETURN",
  );
  assert.equal(
    routeOf({
      sourceAccount: "EMP000000003",
      targetAccount: SETTLEMENT_ACCOUNT,
    }),
    undefined,
    "The suspended fixture has no bank details",
  );
  assert.throws(() => parseAllocation(payout));
  assert.equal(parseTransfer(payout).targetAccount, SETTLEMENT_ACCOUNT);
  const id = randomUUID();
  assert.equal(returnKey(id), returnKey(id));
  assert.notEqual(returnKey(id), deriveUuid("other", id));
  assert.match(
    returnKey(id),
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    payoutStatus({
      debitStatus: "POSTED",
      fileId: "f",
      bankOutcome: "RETURNED",
      returnStatus: "AWAITING_BATCH",
    }),
    "RETURN_PENDING",
  );
});

function payout(id: string, overrides: Partial<Payout> = {}): Payout {
  const p = {
    id,
    clientId: "INSURER_DEMO",
    employeeAccount: "EMP000000001",
    amountMinor: 10000,
    currency: "ZAR" as const,
    branch: one.branch,
    bankAccount: one.account,
    holder: one.holder,
    debitStatus: "POSTED" as const,
    fileId: null,
    bankOutcome: null,
    returnCode: null,
    returnAllocationId: null,
    returnStatus: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  return { ...p, status: payoutStatus(p) };
}
const core = (
  reference: string,
  source: string,
  target: string,
  amountMinor: number,
): LegacyResult => ({
  reference,
  sourceAccount: source,
  targetAccount: target,
  amountMinor,
  currency: "ZAR",
  status: "POSTED",
  reason: "OK",
  postingId: reference,
});
function inventory(
  records: LegacyResult[],
  settlement: number,
): LegacyInventory {
  const employee = records.reduce(
    (sum, r) =>
      sum +
      (r.targetAccount === "EMP000000001" ? r.amountMinor : 0) -
      (r.sourceAccount === "EMP000000001" ? r.amountMinor : 0),
    0,
  );
  const client = records
    .filter((r) => r.sourceAccount === "INS000000001")
    .reduce((s, r) => s + r.amountMinor, 0);
  const balance = (account: string, amountMinor: number, kind: any) => ({
    account,
    amountMinor,
    currency: "ZAR" as const,
    kind,
    state: "ACTIVE" as const,
  });
  return {
    requests: records.map((r) => ({ ...r })),
    batches: [],
    truncated: false,
    core: {
      records,
      balances: [
        balance("INS000000001", 10_000_000 - client, "CLIENT"),
        balance("EMP000000001", employee, "EMPLOYEE"),
        balance(SETTLEMENT_ACCOUNT, settlement, "SETTLEMENT"),
      ],
      generation: "gen-test",
      observedAt: new Date().toISOString(),
      truncated: false,
    },
  };
}

test("the settlement break report explains every cent and flags postings outside the hub", () => {
  const [paid, returned, waiting, credit, funding] = [1, 2, 3, 4, 5].map(() =>
    randomUUID(),
  );
  const content = buildEft({
    userCode: USER_CODE,
    fileId: randomUUID(),
    generation: 1,
    actionDate: "2026-10-21",
    items: [paid, returned].map((reference) => ({
      reference,
      ...one,
      amountMinor: 10000,
    })),
  });
  const fileId = parseEft(content).fileId;
  const file: StoredPayoutFile = {
    id: fileId,
    clientId: "INSURER_DEMO",
    generation: 1,
    actionDate: "2026-10-21",
    itemCount: 2,
    amountTotal: 20000,
    hashTotal: 0,
    sha256: sha256(content),
    status: "RESPONSE_PROCESSED",
    createdAt: new Date().toISOString(),
    content,
  };
  const payouts = [
    payout(paid, { fileId, bankOutcome: "PAID" }),
    payout(returned, {
      fileId,
      bankOutcome: "RETURNED",
      returnCode: "AC",
      returnAllocationId: credit,
      returnStatus: "POSTED",
    }),
    payout(waiting),
  ];
  const records = [
    core(funding, "INS000000001", "EMP000000001", 50000),
    ...[paid, returned, waiting].map((r) =>
      core(r, "EMP000000001", SETTLEMENT_ACCOUNT, 10000),
    ),
    core(credit, SETTLEMENT_ACCOUNT, "EMP000000001", 10000),
  ];
  const modern = [funding, paid, returned, waiting, credit].map((id) => {
    const r = records.find((x) => x.reference === id)!;
    return {
      id,
      clientId: "INSURER_DEMO",
      sourceAccount: r.sourceAccount,
      targetAccount: r.targetAccount,
      amountMinor: r.amountMinor,
      currency: "ZAR" as const,
      status: "POSTED" as const,
      reason: "OK",
      postingId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
  const scan = { payouts, files: [file], truncated: false };
  const clean = compare(
    modern,
    inventory(records, 20000),
    Date.now(),
    false,
    scan,
  );
  assert.deepEqual(
    clean.filter((f) => f.severity === "HIGH"),
    [],
  );
  const summary = clean.find((f) => f.code === "SETTLEMENT_SUMMARY")!;
  assert.match(
    summary.details,
    /Settlement R200\.00: paid by the bank R100\.00/,
  );
  assert.match(summary.details, /debited awaiting a file R100\.00/);
  assert.ok(
    clean.some(
      (f) => f.code === "PAYOUT_AWAITING_FILE" && f.reference === waiting,
    ),
  );

  // A payout posted straight into settlement, bypassing the hub.
  const stray = randomUUID();
  const outside = compare(
    modern,
    inventory(
      [...records, core(stray, "EMP000000001", SETTLEMENT_ACCOUNT, 500)],
      20500,
    ),
    Date.now(),
    false,
    scan,
  );
  assert.ok(
    outside.some(
      (f) =>
        f.code === "SETTLEMENT_POSTING_OUTSIDE_HUB" && f.reference === stray,
    ),
  );
  assert.ok(outside.some((f) => f.code === "SETTLEMENT_BREAK"));

  // An instruction claims the file but the debit never posted in the core.
  const unfunded = compare(
    modern,
    inventory(
      records.filter((r) => r.reference !== paid),
      10000,
    ),
    Date.now(),
    false,
    scan,
  );
  assert.ok(
    unfunded.some(
      (f) => f.code === "PAYOUT_FILED_WITHOUT_DEBIT" && f.reference === paid,
    ),
  );
  const extra = compare(modern, inventory(records, 20000), Date.now(), false, {
    ...scan,
    payouts: [...payouts, payout(randomUUID(), { fileId })],
  });
  assert.ok(extra.some((f) => f.code === "PAYOUT_FILE_CONTROL_MISMATCH"));
});

test("payout API: payroll requests, operations files and submits, employees only read their own", async () => {
  const created: any[] = [];
  const store = {
    createPayout: async (clientId: string, key: string, input: any) => {
      created.push({ clientId, key, input });
      return payout(randomUUID());
    },
    listPayouts: async (_c: string, employee?: string) => {
      assert.equal(employee, "EMP000000001");
      return [payout(randomUUID())];
    },
    createPayoutFile: async () => undefined,
    listPayoutFiles: async () => [],
  } as unknown as PayoutStore;
  const app = makeApp({} as any, {} as any, {
    sessionSecret: "test-secret",
    demoPassword: "test-password",
    payouts: { store, bank: {} as Bank },
  });
  const auth = (user: string) => ({
    authorization: `Bearer ${issue(user, "test-secret")}`,
    "idempotency-key": randomUUID(),
  });
  const body = { employeeAccount: "EMP000000001", amountMinor: 10000 };
  const post = (url: string, user: string, payload: unknown = body) =>
    app.inject({
      method: "POST",
      url,
      headers: auth(user),
      payload: payload as any,
    });
  assert.equal((await post("/payouts", "employee-one")).statusCode, 403);
  assert.equal((await post("/payouts", "insurer-admin")).statusCode, 202);
  assert.equal(created[0].input.targetAccount, SETTLEMENT_ACCOUNT);
  assert.equal(
    (
      await post("/payouts", "insurer-admin", {
        ...body,
        employeeAccount: "EMP000000003",
      })
    ).statusCode,
    400,
    "No bank details, no payout",
  );
  assert.equal(
    (await post("/payouts", "insurer-admin", { ...body, amountMinor: 1.5 }))
      .statusCode,
    400,
  );
  assert.equal(
    (await post("/payout-files", "insurer-admin", {})).statusCode,
    403,
  );
  assert.equal((await post("/payout-files", "ops", {})).statusCode, 409);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/payout-files",
        headers: auth("insurer-admin"),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/payouts",
        headers: auth("employee-one"),
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/bank-responses",
        headers: { ...auth("ops"), "content-type": "text/plain" },
        payload: "not a response",
      })
    ).statusCode,
    400,
  );
  await app.close();
});
