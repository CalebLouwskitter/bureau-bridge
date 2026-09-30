import assert from "node:assert/strict";
import { LegacyClient } from "../src/legacy.ts";
import { compare } from "../src/reconciliation.ts";
const base = process.env.LEGACY_URL ?? "http://localhost:8080";
const legacy = new LegacyClient(
  base,
  process.env.LEGACY_BRIDGE_KEY!,
  process.env.LEGACY_OPS_KEY!,
);
const snapshot = await legacy.accounts(),
  inventory = await legacy.inventory();
assert.equal(
  snapshot.balances.reduce((sum, a) => sum + a.amountMinor, 0),
  10_000_000,
);
assert.equal(snapshot.generation, inventory.core.generation);
assert.equal(
  snapshot.balances.find((a) => a.account === "EMP000000003")!.state,
  "SUSPENDED",
);
assert.ok(
  !compare([], inventory).some((f) => f.severity === "HIGH"),
  "Journal, balances, payloads and batch controls must match",
);
for (const path of [
  "/v1/accounts",
  "/v1/reconciliation",
  "/reports/batches.csv",
])
  assert.equal((await fetch(base + path)).status, 401);
const headers = {
  Authorization:
    "Basic " +
    Buffer.from("operator:" + process.env.DEMO_PASSWORD).toString("base64"),
};
for (const path of ["/reports/batches.csv", "/reports/requests.csv"]) {
  const report = await fetch(base + path, { headers });
  assert.equal(report.status, 200);
  assert.match(report.headers.get("content-type")!, /text\/csv/);
  assert.ok((await report.text()).split("\n").length > 1);
}
const portal = await fetch(base + "/", { headers });
assert.equal(portal.status, 200);
const csrf = (await portal.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1];
const cookie = portal.headers.get("set-cookie")!.split(";")[0];
const formHeaders = {
  ...headers,
  Cookie: cookie,
  "Content-Type": "application/x-www-form-urlencoded",
};
const valid = await fetch(base + "/", {
  method: "POST",
  headers: formHeaders,
  body: new URLSearchParams({
    csrf,
    targetAccount: "EMP000000002",
    amountMinor: "1",
  }),
});
assert.equal(valid.status, 200);
assert.match(await valid.text(), /Received/);
const invalid = await fetch(base + "/", {
  method: "POST",
  headers: formHeaders,
  body: new URLSearchParams({
    csrf: "wrong",
    targetAccount: "EMP000000002",
    amountMinor: "1",
  }),
});
assert.equal(invalid.status, 400);
console.log(
  "PASS TypeScript client against real PHP account/audit endpoints, journal/balance reconciliation, authenticated CSV reports and operator session/CSRF forms",
);
