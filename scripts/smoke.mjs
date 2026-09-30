import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
assert.ok(!run.findings.some((f) => f.severity === "HIGH"));
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
  "PASS: intake/replay/conflict, posting and lost-result recovery, suspended decline, private account projection, reconciliation and CSV report.",
);
