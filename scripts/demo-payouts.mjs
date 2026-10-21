// Narrated payout walkthrough for a live demo. It changes local demo data.
// Usage: npm run demo:payouts            (runs straight through)
//        npm run demo:payouts -- --step  (waits for Enter between steps)
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const base = process.env.API_URL ?? "http://localhost:3000";
const bankBase = process.env.BANK_URL ?? "http://localhost:3100";
const stepping = process.argv.includes("--step") && process.stdin.isTTY;
const prompt = stepping
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;
const rand = (minor) => `R${(minor / 100).toFixed(2)}`;
let n = 0;
async function step(title, why) {
  console.log(`\n\x1b[1m${++n}. ${title}\x1b[0m\n   ${why}`);
  if (prompt) await prompt.question("   [Enter] ");
}
const show = (label, value) => console.log(`   ${label.padEnd(22)} ${value}`);
// The walkthrough doubles as a check: any wrong outcome fails the run.
const expect = (ok, label) => {
  if (ok) return;
  process.exitCode = 1;
  console.log(`   \x1b[31m✗ ${label}\x1b[0m`);
};

async function login(username) {
  const r = await fetch(base + "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: process.env.DEMO_PASSWORD }),
  });
  if (r.status !== 200) throw new Error(`Sign-in failed for ${username}`);
  return (await r.json()).token;
}
const call = async (path, token, method = "GET", payload, key) => {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, headers: r.headers };
};
const batch = () => {
  const r = spawnSync(
    "docker",
    ["compose", "exec", "-T", "legacy", "php", "/app/php/batch.php"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr || "Batch failed");
  show("COBOL batch", r.stdout.trim());
};
async function until(id, token, states) {
  for (let i = 0; i < 45; i++) {
    const r = await call(`/allocations/${id}`, token);
    if (states.includes(r.body.status)) return r.body;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${states}`);
}
const bankHeaders = {
  Authorization: `Bearer ${process.env.BANK_KEY}`,
  "Content-Type": "application/json",
};

const payroll = await login("insurer-admin"),
  ops = await login("ops");

await step(
  "Fund Employee 2's payable",
  "An internal allocation, as in the original demo: prefund → employee payable, posted by COBOL.",
);
const funding = (
  await call(
    "/allocations",
    payroll,
    "POST",
    {
      sourceAccount: "INS000000001",
      targetAccount: "EMP000000002",
      amountMinor: 30000,
      currency: "ZAR",
    },
    randomUUID(),
  )
).body;
await until(funding.id, payroll, ["AWAITING_BATCH"]);
batch();
show("Allocation", (await until(funding.id, payroll, ["POSTED"])).status);

await step(
  "Request two payouts",
  "Each payout is a core debit from the payable into the bank settlement account. Its reference will also be its line in the bank file.",
);
const key = randomUUID();
const one = await call(
  "/payouts",
  payroll,
  "POST",
  { employeeAccount: "EMP000000001", amountMinor: 10000 },
  key,
);
const again = await call(
  "/payouts",
  payroll,
  "POST",
  { employeeAccount: "EMP000000001", amountMinor: 10000 },
  key,
);
const two = await call(
  "/payouts",
  payroll,
  "POST",
  { employeeAccount: "EMP000000002", amountMinor: 30000 },
  randomUUID(),
);
show("Employee 1 payout", `${one.body.id} · ${one.body.status}`);
show(
  "Same key replayed",
  again.body.id === one.body.id ? "same instruction" : "NEW (bug)",
);
show("Employee 2 payout", `${two.body.id} · ${two.body.status}`);
expect(
  again.body.id === one.body.id,
  "A replayed payout key must return the same instruction",
);

await step(
  "Try to file before the debit posts",
  "Money only goes into a bank file after the core has debited the payable.",
);
const early = await call("/payout-files", ops, "POST", {}, randomUUID());
show("Generate file", `${early.status} · ${early.body.error}`);
expect(
  early.status === 409,
  "Payouts must not be filed before their debit posts",
);
await until(one.body.id, payroll, ["AWAITING_BATCH"]);
await until(two.body.id, payroll, ["AWAITING_BATCH"]);
batch();
await until(one.body.id, payroll, ["POSTED"]);
await until(two.body.id, payroll, ["POSTED"]);
show("Debits", "posted in the core");

await step(
  "Generate the EFT file",
  "Every debited, unfiled payout is claimed under a lock. Replaying the request key returns the same file.",
);
const fileKey = randomUUID();
const file = (await call("/payout-files", ops, "POST", {}, fileKey)).body;
const replay = (await call("/payout-files", ops, "POST", {}, fileKey)).body;
const eft = await call(`/payout-files/${file.id}/eft.txt`, ops);
show(
  "File",
  `generation ${file.generation} · ${file.itemCount} items · ${rand(file.amountTotal)}`,
);
show("Replayed key", replay.id === file.id ? "same file" : "NEW (bug)");
show(
  "Bytes match hash",
  String(
    createHash("sha256").update(eft.body).digest("hex") ===
      eft.headers.get("x-content-sha256"),
  ),
);
expect(
  replay.id === file.id &&
    createHash("sha256").update(eft.body).digest("hex") ===
      eft.headers.get("x-content-sha256"),
  "File replay and stored bytes must be stable",
);
console.log(
  eft.body
    .split("\n")
    .filter(Boolean)
    .map((line) => `     │ ${line}`)
    .join("\n"),
);

await step(
  "Lose the bank's answer",
  "The bank processes the file, but the response never reaches us. Is it safe to send again?",
);
await fetch(bankBase + "/faults", {
  method: "POST",
  headers: bankHeaders,
  body: JSON.stringify({ dropNextResponse: true }),
});
const lost = await call(`/payout-files/${file.id}/submit`, ops, "POST", {});
show("Submit", `${lost.status} · ${lost.body.error}`);
const status = (await call("/payout-files", ops)).body.files.find(
  (f) => f.id === file.id,
).status;
show("File status", status);
expect(
  lost.status === 502 && status === "SUBMISSION_UNKNOWN",
  "A lost response must leave the outcome unknown",
);

await step(
  "Submit again",
  "The hub asks the bank about this generation first. The bank already has it, so nothing is sent twice.",
);
const answered = (
  await call(`/payout-files/${file.id}/submit`, ops, "POST", {})
).body;
show(
  "Result",
  `paid ${answered.paid} · returned ${answered.returned} · duplicate ${answered.duplicate}`,
);
const response = await (
  await fetch(`${bankBase}/files/BUREAU01/${file.generation}/response`, {
    headers: bankHeaders,
  })
).text();
const reimport = await fetch(base + "/bank-responses", {
  method: "POST",
  headers: { Authorization: `Bearer ${ops}`, "Content-Type": "text/plain" },
  body: response,
});
const reimported = await reimport.json();
show("Re-import response", `duplicate ${reimported.duplicate}`);
expect(
  answered.duplicate === false && reimported.duplicate === true,
  "The response must be processed exactly once",
);

await step(
  "Credit back the return",
  "Employee 2's bank account is closed (code AC). The return becomes a keyed core credit from settlement, posted in the next batch.",
);
const returned = (await call("/payouts", ops)).body.payouts.find(
  (p) => p.id === two.body.id,
);
show("Employee 2 payout", `${returned.status} · ${returned.returnCode}`);
expect(
  returned.status === "RETURN_PENDING",
  "Employee 2's payout must be returned",
);
await until(returned.returnAllocationId, payroll, ["AWAITING_BATCH"]);
batch();
await until(returned.returnAllocationId, payroll, ["POSTED"]);
const credited = (await call("/payouts", ops)).body.payouts.find(
  (p) => p.id === two.body.id,
).status;
show("Employee 2 payout", credited);
expect(credited === "RETURNED", "The return credit must post");

await step(
  "Reconcile the settlement account",
  "Every cent in settlement must be explained by a payout instruction.",
);
const run = (await call("/reconciliation", ops, "POST", {})).body.run;
for (const f of run.findings.filter(
  (f) => f.severity !== "INFO" || f.code === "SETTLEMENT_SUMMARY",
))
  show(f.severity, `${f.code}: ${f.details}`);
const high = run.findings.filter((f) => f.severity === "HIGH").length;
show("HIGH findings", high);
expect(high === 0, "Reconciliation must have no HIGH findings");
prompt?.close();
