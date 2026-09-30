import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  parseAllocation,
  parsePending,
  type Allocation,
} from "@bureau/contracts";
import { makeApp } from "../src/app.ts";
import { issue, verify } from "../src/auth.ts";
import { tick } from "../src/worker.ts";
import type { Store } from "../src/store.ts";
import type { Legacy, LegacyResult } from "../src/legacy.ts";
const id = randomUUID();
const allocation: Allocation = {
  id,
  clientId: "INSURER_DEMO",
  sourceAccount: "INS000000001",
  targetAccount: "EMP000000001",
  amountMinor: 25000,
  currency: "ZAR",
  status: "QUEUED",
  reason: null,
  postingId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
function fixture() {
  const outcomes: any[] = [],
    retries: any[] = [];
  const accounts = [
    {
      account: "EMP000000001",
      amountMinor: 0,
      currency: "ZAR" as const,
      kind: "EMPLOYEE" as const,
      state: "ACTIVE" as const,
      generation: "gen-test",
      sequence: 0,
      observedAt: new Date().toISOString(),
    },
  ];
  let saved: any;
  const store: Store = {
    create: async () => allocation,
    list: async () => [allocation],
    get: async () => allocation,
    events: async () => [],
    claim: async () => ({ id, token: "lease", failures: 0 }),
    finish: async (_job, outcome) => {
      outcomes.push(outcome);
    },
    retry: async (_job, error) => {
      retries.push(error);
    },
    wake: async () => {},
    accounts: async (_client, employee) => {
      assert.equal(employee, "EMP000000001");
      return accounts;
    },
    syncAccounts: async () => {},
    scan: async () => ({ allocations: [allocation], truncated: false }),
    saveReconciliation: async (run) => {
      saved = run;
    },
    latestReconciliation: async () => saved,
  };
  const result: LegacyResult = {
    ...allocation,
    reference: id,
    status: "POSTED",
    postingId: id,
  };
  const legacy: Legacy = {
    lookup: async () => result,
    submit: async () => result,
    inquire: async () => ({ request: result }),
    retryUnposted: async () => ({ request: result }),
    accounts: async () => ({
      generation: "gen-test",
      sequence: 0,
      observedAt: new Date().toISOString(),
      balances: accounts,
    }),
    inventory: async () => ({
      requests: [result],
      batches: [],
      truncated: false,
      core: {
        records: [result],
        balances: [
          {
            account: "INS000000001",
            amountMinor: 9_975_000,
            currency: "ZAR",
            kind: "CLIENT",
            state: "ACTIVE",
          },
          { ...accounts[0], amountMinor: 25_000 },
        ],
        generation: "gen-test",
        observedAt: new Date().toISOString(),
        truncated: false,
      },
    }),
  };
  return { store, legacy, result, outcomes, retries };
}
test("lookup after a lost acknowledgment prevents a second submission", async () => {
  const f = fixture();
  f.legacy.submit = async () => {
    assert.fail("Must not resubmit a known legacy reference");
  };
  await tick(f.store, f.legacy);
  assert.equal(f.outcomes[0].status, "POSTED");
  assert.equal(f.retries.length, 0);
});
test("timeout stays unresolved and never claims a posting", async () => {
  const f = fixture();
  f.legacy.lookup = async () => {
    throw new Error("timeout");
  };
  f.legacy.submit = async () => {
    assert.fail("An unknown lookup outcome does not authorize new submission");
  };
  await tick(f.store, f.legacy);
  assert.equal(f.outcomes.length, 0);
  assert.equal(f.retries.length, 1);
});
test("unknown reference can be submitted with original immutable id", async () => {
  const f = fixture();
  f.legacy.lookup = async () => undefined;
  f.legacy.submit = async (a) => {
    assert.equal(a.id, id);
    return { ...f.result, status: "RECEIVED", postingId: null };
  };
  await tick(f.store, f.legacy);
  assert.equal(f.outcomes[0].status, "AWAITING_BATCH");
});
test("mismatched legacy amount requires review, not success", async () => {
  const f = fixture();
  f.legacy.lookup = async () => ({ ...f.result, amountMinor: 500 });
  await tick(f.store, f.legacy);
  assert.equal(f.outcomes.length, 0);
  assert.equal(f.retries[0], "LEGACY_RESPONSE_MISMATCH");
});
test("money contracts reject floating point amounts and unsupported account access", () => {
  assert.throws(() => parseAllocation({ ...allocation, amountMinor: 2.5 }));
  assert.throws(() =>
    parseAllocation({ ...allocation, sourceAccount: "OTHERCLIENT1" }),
  );
  assert.throws(() => parseAllocation({ ...allocation, amountMinor: 0 }));
});
test("signed sessions reject changes and expiry", () => {
  const token = issue("insurer-admin", "test-secret", 1000)!;
  assert.equal(verify(token, "test-secret", 1000)?.role, "payroll");
  assert.equal(verify(token + "x", "test-secret", 1000), undefined);
  assert.equal(verify(token, "test-secret", 4_000_000), undefined);
  for (const username of ["toString", "__proto__", "constructor"])
    assert.equal(issue(username, "test-secret"), undefined);
});
test("a known final allocation closes its job without contacting an unavailable legacy system", async () => {
  const f = fixture();
  f.store.get = async () => ({
    ...allocation,
    status: "POSTED",
    postingId: id,
  });
  f.legacy.lookup = async () => {
    assert.fail("A final outcome must not be downgraded by delivery failure");
  };
  await tick(f.store, f.legacy);
  assert.equal(f.outcomes[0].status, "POSTED");
  assert.equal(f.retries.length, 0);
});
test("damaged or invalid mobile retry caches are rejected; valid payloads retain their reference", () => {
  assert.equal(parsePending("{broken"), undefined);
  assert.equal(
    parsePending(
      JSON.stringify({
        key: id,
        targetAccount: "EMP000000001",
        amountMinor: -1,
      }),
    ),
    undefined,
  );
  assert.equal(
    parsePending(
      JSON.stringify({
        key: id,
        targetAccount: "EMP000000001",
        amountMinor: 1e15,
      }),
    ),
    undefined,
  );
  assert.deepEqual(
    parsePending(
      JSON.stringify({
        key: id,
        targetAccount: "EMP000000001",
        amountMinor: 25000,
      }),
    ),
    { key: id, targetAccount: "EMP000000001", amountMinor: 25000 },
  );
});
test("API enforces employee ownership, roles, and operation-only inquiry", async () => {
  const f = fixture();
  const app = makeApp(f.store, f.legacy, {
    sessionSecret: "test-secret",
    demoPassword: "test-password",
  });
  const employee = issue("employee-one", "test-secret")!,
    payroll = issue("insurer-admin", "test-secret")!;
  assert.equal(
    (await app.inject({ method: "GET", url: "/allocations" })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/allocations",
        headers: {
          authorization: `Bearer ${employee}`,
          "idempotency-key": randomUUID(),
        },
        payload: allocation,
      })
    ).statusCode,
    403,
  );
  f.store.get = async () => ({ ...allocation, targetAccount: "EMP000000002" });
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/allocations/${id}`,
        headers: { authorization: `Bearer ${employee}` },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/allocations/${id}/inquiry`,
        headers: { authorization: `Bearer ${payroll}` },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/allocations",
        headers: { authorization: `Bearer ${payroll}` },
        payload: allocation,
      })
    ).statusCode,
    400,
  );
  const balances = await app.inject({
    method: "GET",
    url: "/accounts",
    headers: { authorization: `Bearer ${employee}` },
  });
  assert.equal(balances.statusCode, 200);
  assert.equal(balances.json().accounts[0].account, "EMP000000001");
  for (const path of ["/reconciliation", "/reconciliation/report.csv"])
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: path,
          headers: { authorization: `Bearer ${payroll}` },
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/reconciliation",
        headers: { authorization: `Bearer ${employee}` },
        payload: {},
      })
    ).statusCode,
    403,
  );
  const ops = issue("ops", "test-secret")!;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/reconciliation",
        headers: { authorization: `Bearer ${ops}` },
        payload: {},
      })
    ).statusCode,
    200,
  );
  const csv = await app.inject({
    method: "GET",
    url: "/reconciliation/report.csv",
    headers: { authorization: `Bearer ${ops}` },
  });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers["content-type"]!, /text\/csv/);
  f.store.get = async () => ({
    ...allocation,
    status: "POSTED",
    postingId: id,
  });
  f.store.wake = async () => {
    assert.fail("Inquiry must not requeue a final allocation");
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/allocations/${id}/inquiry`,
        headers: { authorization: `Bearer ${ops}` },
        payload: {},
      })
    ).statusCode,
    200,
  );
  await app.close();
});
