import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
const base = process.env.API_URL ?? "http://localhost:3000";
async function login(username) {
  const r = await fetch(base + "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(r.status, 200);
  return (await r.json()).token;
}
const token = await login("insurer-admin"),
  ops = await login("ops");
const body = {
  sourceAccount: "INS000000001",
  targetAccount: "EMP000000001",
  amountMinor: 25000,
  currency: "ZAR",
};
async function submit(key, data = body) {
  return fetch(base + "/allocations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": key,
    },
    body: JSON.stringify(data),
  });
}
async function wait(id, states) {
  for (let i = 0; i < 45; i++) {
    const r = await fetch(base + `/allocations/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
    const a = await r.json();
    if (states.includes(a.status)) return a;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${states}`);
}
function batch(drop = false) {
  const args = ["compose", "exec", "-T", "legacy", "php", "/app/php/batch.php"];
  if (drop) args.push("--drop-result");
  const result = spawnSync("docker", args, { encoding: "utf8" });
  assert.equal(result.status, drop ? 1 : 0, result.stderr);
}
const key = randomUUID();
const first = await submit(key);
assert.equal(first.status, 202);
const a = await first.json();
assert.equal((await (await submit(key)).json()).id, a.id);
assert.equal((await submit(key, { ...body, amountMinor: 25001 })).status, 409);
await wait(a.id, ["AWAITING_BATCH"]);
batch();
await wait(a.id, ["POSTED"]);
const b = await (await submit(randomUUID())).json();
await wait(b.id, ["AWAITING_BATCH"]);
batch(true);
await wait(b.id, ["VERIFYING"]);
const inquiry = await fetch(base + `/allocations/${b.id}/inquiry`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${ops}`,
    "Content-Type": "application/json",
  },
  body: "{}",
});
assert.equal(inquiry.status, 200);
await wait(b.id, ["POSTED"]);
const declined = await (
  await submit(randomUUID(), {
    ...body,
    targetAccount: "EMP000000003",
    amountMinor: 1,
  })
).json();
await wait(declined.id, ["AWAITING_BATCH"]);
batch();
assert.equal(
  (await wait(declined.id, ["DECLINED"])).reason,
  "TARGET_SUSPENDED",
);
const employeeToken = await login("employee-one");
let accounts = [];
for (let i = 0; i < 45; i++) {
  const response = await fetch(base + "/accounts", {
    headers: { Authorization: `Bearer ${employeeToken}` },
  });
  assert.equal(response.status, 200);
  accounts = (await response.json()).accounts;
  if (accounts.length) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.equal(accounts.length, 1);
assert.equal(accounts[0].account, "EMP000000001");
// Payout leg: debit payables into settlement, file them, lose the bank's
// answer once, recover it by inquiry, and credit back the returned item.
const bankBase = process.env.BANK_URL ?? "http://localhost:3100";
const call = (path, user, method = "GET", key, payload) =>
  fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${user}`,
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
const funding = await (
  await submit(randomUUID(), {
    ...body,
    targetAccount: "EMP000000002",
    amountMinor: 30000,
  })
).json();
await wait(funding.id, ["AWAITING_BATCH"]);
batch();
await wait(funding.id, ["POSTED"]);
const payoutKey = randomUUID();
const payOne = await call("/payouts", token, "POST", payoutKey, {
  employeeAccount: "EMP000000001",
  amountMinor: 10000,
});
assert.equal(payOne.status, 202);
const p1 = await payOne.json();
assert.equal(
  (
    await (
      await call("/payouts", token, "POST", payoutKey, {
        employeeAccount: "EMP000000001",
        amountMinor: 10000,
      })
    ).json()
  ).id,
  p1.id,
);
const p2 = await (
  await call("/payouts", token, "POST", randomUUID(), {
    employeeAccount: "EMP000000002",
    amountMinor: 30000,
  })
).json();
await wait(p1.id, ["AWAITING_BATCH"]);
await wait(p2.id, ["AWAITING_BATCH"]);
assert.equal(
  (await call("/payout-files", ops, "POST", randomUUID(), {})).status,
  409,
  "Payouts cannot be filed before the core debit posts",
);
batch();
await wait(p1.id, ["POSTED"]);
await wait(p2.id, ["POSTED"]);
const fileKey = randomUUID();
const generated = await call("/payout-files", ops, "POST", fileKey, {});
assert.equal(generated.status, 201);
const file = await generated.json();
assert.equal(file.itemCount, 2);
assert.equal(
  (await (await call("/payout-files", ops, "POST", fileKey, {})).json()).id,
  file.id,
);
assert.equal(
  (await call("/payout-files", ops, "POST", randomUUID(), {})).status,
  409,
);
const eft = await call(`/payout-files/${file.id}/eft.txt`, ops);
const eftText = await eft.text();
assert.equal(
  createHash("sha256").update(eftText).digest("hex"),
  eft.headers.get("x-content-sha256"),
);
const bankHeaders = {
  Authorization: `Bearer ${process.env.BANK_KEY}`,
  "Content-Type": "application/json",
};
assert.equal(
  (
    await fetch(bankBase + "/faults", {
      method: "POST",
      headers: bankHeaders,
      body: JSON.stringify({ dropNextResponse: true }),
    })
  ).status,
  200,
);
assert.equal(
  (await call(`/payout-files/${file.id}/submit`, ops, "POST", undefined, {}))
    .status,
  502,
);
assert.equal(
  (await (await call("/payout-files", ops)).json()).files.find(
    (f) => f.id === file.id,
  ).status,
  "SUBMISSION_UNKNOWN",
);
const answered = await (
  await call(`/payout-files/${file.id}/submit`, ops, "POST", undefined, {})
).json();
assert.deepEqual(
  [answered.paid, answered.returned, answered.duplicate],
  [1, 1, false],
);
const bankResponse = await (
  await fetch(`${bankBase}/files/BUREAU01/${file.generation}/response`, {
    headers: bankHeaders,
  })
).text();
const replayed = await fetch(base + "/bank-responses", {
  method: "POST",
  headers: { Authorization: `Bearer ${ops}`, "Content-Type": "text/plain" },
  body: bankResponse,
});
assert.equal((await replayed.json()).duplicate, true);
const payoutsNow = (await (await call("/payouts", ops)).json()).payouts;
assert.equal(payoutsNow.find((p) => p.id === p1.id).status, "PAID");
const returned = payoutsNow.find((p) => p.id === p2.id);
assert.equal(returned.status, "RETURN_PENDING");
assert.equal(returned.returnCode, "AC");
await wait(returned.returnAllocationId, ["AWAITING_BATCH"]);
batch();
await wait(returned.returnAllocationId, ["POSTED"]);
assert.equal(
  (await (await call("/payouts", ops)).json()).payouts.find(
    (p) => p.id === p2.id,
  ).status,
  "RETURNED",
);
const ownPayouts = (await (await call("/payouts", employeeToken)).json())
  .payouts;
assert.ok(ownPayouts.every((p) => p.employeeAccount === "EMP000000001"));
const report = await fetch(base + "/reconciliation", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${ops}`,
    "Content-Type": "application/json",
  },
  body: "{}",
});
assert.equal(report.status, 200);
const run = (await report.json()).run;
assert.equal(run.truncated, false);
assert.deepEqual(
  run.findings.filter((f) => f.severity === "HIGH"),
  [],
);
assert.match(
  run.findings.find((f) => f.code === "SETTLEMENT_SUMMARY").details,
  // Everything left in settlement was paid; the returned item was credited.
  /^Settlement (R[\d.]+): paid by the bank \1, in files awaiting a response R0\.00, debited awaiting a file R0\.00, returned awaiting credit R0\.00\.$/,
);
const csv = await fetch(base + "/reconciliation/report.csv", {
  headers: { Authorization: `Bearer ${ops}` },
});
assert.equal(csv.status, 200);
assert.match(csv.headers.get("content-type"), /text\/csv/);
assert.equal(
  (
    await fetch(base + "/reconciliation", {
      headers: { Authorization: `Bearer ${employeeToken}` },
    })
  ).status,
  403,
);
console.log(
  "PASS: intake/replay/conflict, posting and lost-result recovery, suspended decline, private account projection, payout file generation, lost bank response recovery, bank return credit, settlement reconciliation and CSV report.",
);
