#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

// Automatically load local .env if DEMO_PASSWORD is not set in environment
if (!process.env.DEMO_PASSWORD) {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envPath);
    } catch {}
  }
}

const { values } = parseArgs({
  options: {
    count: { type: "string", short: "n", default: "500" },
    concurrency: { type: "string", short: "c", default: "10" },
    replay: { type: "boolean", default: false },
    amount: { type: "string", default: "100" },
    url: {
      type: "string",
      default: process.env.API_URL ?? "http://localhost:3000",
    },
    timeout: { type: "string", default: "300" },
    "auto-batch": { type: "boolean", default: true },
    "batch-interval": { type: "string", default: "2000" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Usage: node scripts/load/allocations.mjs [options]

Options:
  -n, --count <number>          Number of allocation requests (default: 500)
  -c, --concurrency <number>    Concurrency limit (default: 10)
      --replay                  Send every request twice concurrently with same key (idempotency test)
      --amount <minor>          Allocation amount in cents (default: 100 = R1.00)
      --url <url>               API base URL (default: http://localhost:3000)
      --timeout <seconds>       Timeout in seconds waiting for final states (default: 300)
      --auto-batch              Trigger legacy batch runner during polling (default: true)
      --batch-interval <ms>     Interval between batch triggers in ms (default: 2000)
  -h, --help                    Show this help message
`);
  process.exit(0);
}

const N = parseInt(values.count, 10);
const C = parseInt(values.concurrency, 10);
const isReplay = Boolean(values.replay);
const amountMinor = parseInt(values.amount, 10);
const base = values.url.replace(/\/+$/, "");
const timeoutMs = parseInt(values.timeout, 10) * 1000;
const autoBatch = values["auto-batch"];
const batchIntervalMs = parseInt(values["batch-interval"], 10);

if (Number.isNaN(N) || N <= 0) {
  console.error("Error: --count must be a positive integer.");
  process.exit(1);
}
if (Number.isNaN(C) || C <= 0) {
  console.error("Error: --concurrency must be a positive integer.");
  process.exit(1);
}

const FINAL_STATES = new Set(["POSTED", "DECLINED", "NEEDS_REVIEW"]);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function stats(numbers) {
  if (numbers.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
  };
}

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function login(username) {
  const res = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password: process.env.DEMO_PASSWORD,
    }),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Login failed for user "${username}" (HTTP ${res.status}): ${text}`,
    );
  }
  const data = await res.json();
  return data.token;
}

function triggerBatch() {
  try {
    const res = spawnSync(
      "docker",
      ["compose", "exec", "-T", "legacy", "php", "/app/php/batch.php"],
      { encoding: "utf8", stdio: "pipe" },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=================================================");
  console.log("  BureauBridge Allocations Load Test");
  console.log("=================================================");
  console.log(`Target URL:        ${base}`);
  console.log(`Unique Keys (N):   ${N}`);
  console.log(`Concurrency (C):   ${C}`);
  console.log(`Mode:              ${isReplay ? "Concurrent Replay (2x per key)" : "Standard"}`);
  console.log(`Total Submissions: ${isReplay ? 2 * N : N}`);
  console.log(`Amount:            R${(amountMinor / 100).toFixed(2)} (${amountMinor} cents)`);
  console.log(`Auto-batching:     ${autoBatch ? "Enabled" : "Disabled"}`);
  console.log("-------------------------------------------------");

  if (!process.env.DEMO_PASSWORD) {
    console.error("Error: DEMO_PASSWORD is not set in environment or .env file.");
    console.error("Please run `node scripts/setup.mjs` first or configure .env.");
    process.exit(1);
  }

  // 1. Authenticate as payroll user and operations user
  console.log("Authenticating demo users...");
  let payrollToken;
  let opsToken;
  try {
    payrollToken = await login("insurer-admin");
    opsToken = await login("ops");
  } catch (err) {
    console.error(`Authentication error: ${err.message}`);
    console.error("Ensure the Docker stack is running: `docker compose up -d`");
    process.exit(1);
  }
  console.log("Authentication successful.");

  // Helper to submit a single HTTP allocation request
  async function submitOnce(key, payload) {
    const t0 = performance.now();
    const res = await fetch(`${base}/allocations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${payrollToken}`,
        "Idempotency-Key": key,
      },
      body: JSON.stringify(payload),
    });
    const t1 = performance.now();
    const latency = t1 - t0;

    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    return {
      status: res.status,
      latency,
      body,
      key,
    };
  }

  // 2. Generate allocation payloads with unique idempotency keys
  const requests = Array.from({ length: N }, (_, i) => ({
    index: i,
    key: randomUUID(),
    payload: {
      sourceAccount: "INS000000001",
      targetAccount: "EMP000000001",
      amountMinor,
      currency: "ZAR",
    },
  }));

  // 3. Dispatch submissions at concurrency C
  console.log(
    `\nSubmitting ${isReplay ? `${N} key pairs (${2 * N} requests concurrently)` : `${N} requests`} at ${C} concurrency...`,
  );
  const submissionStartTime = performance.now();
  const allAcceptanceLatencies = [];

  const submitted = await mapConcurrent(requests, C, async (req) => {
    const tStart = performance.now();

    if (isReplay) {
      // Replay mode: send every request twice concurrently with the exact same idempotency key
      const [res1, res2] = await Promise.all([
        submitOnce(req.key, req.payload),
        submitOnce(req.key, req.payload),
      ]);

      if (res1.status !== 202) {
        throw new Error(
          `Request ${req.index} (call 1) failed with HTTP ${res1.status}: ${JSON.stringify(res1.body)}`,
        );
      }
      if (res2.status !== 202) {
        throw new Error(
          `Request ${req.index} (replay call 2) failed with HTTP ${res2.status}: ${JSON.stringify(res2.body)}`,
        );
      }

      assert.ok(res1.body && res1.body.id, `Missing allocation id in response 1: ${JSON.stringify(res1.body)}`);
      assert.ok(res2.body && res2.body.id, `Missing allocation id in response 2: ${JSON.stringify(res2.body)}`);
      assert.equal(
        res1.body.id,
        res2.body.id,
        `Replay idempotency violation: key ${req.key} returned different IDs (${res1.body.id} vs ${res2.body.id})`,
      );

      allAcceptanceLatencies.push(res1.latency, res2.latency);

      return {
        index: req.index,
        key: req.key,
        id: res1.body.id,
        acceptanceLatency: Math.max(res1.latency, res2.latency),
        submittedAt: tStart,
      };
    } else {
      const res = await submitOnce(req.key, req.payload);

      if (res.status !== 202) {
        throw new Error(
          `Request ${req.index} failed with HTTP ${res.status}: ${JSON.stringify(res.body)}`,
        );
      }

      assert.ok(res.body && res.body.id, `Missing allocation id in response: ${JSON.stringify(res.body)}`);
      allAcceptanceLatencies.push(res.latency);

      return {
        index: req.index,
        key: req.key,
        id: res.body.id,
        acceptanceLatency: res.latency,
        submittedAt: tStart,
      };
    }
  });

  const submissionEndTime = performance.now();
  const totalSubmissionSec = (submissionEndTime - submissionStartTime) / 1000;
  const acceptanceStats = stats(allAcceptanceLatencies);
  const totalHttpRequests = isReplay ? 2 * N : N;
  const throughput = totalHttpRequests / totalSubmissionSec;

  console.log(
    `All ${totalHttpRequests} HTTP requests accepted in ${totalSubmissionSec.toFixed(2)}s (${throughput.toFixed(1)} req/s).`,
  );

  // 4. Poll until every request reaches a final state
  console.log(`\nWaiting for all requests to reach a final state (timeout: ${timeoutMs / 1000}s)...`);
  const pollStartTime = performance.now();

  const resultsById = new Map();
  for (const s of submitted) {
    resultsById.set(s.id, {
      id: s.id,
      key: s.key,
      submittedAt: s.submittedAt,
      acceptanceLatency: s.acceptanceLatency,
      finalStatus: null,
      postingId: null,
      reason: null,
      e2eLatency: null,
    });
  }

  let pendingIds = submitted.map((s) => s.id);
  let lastBatchTrigger = 0;

  while (pendingIds.length > 0) {
    if (performance.now() - pollStartTime > timeoutMs) {
      const remainingStates = new Map();
      for (const id of pendingIds) {
        const item = resultsById.get(id);
        const st = item.finalStatus ?? "PENDING";
        remainingStates.set(st, (remainingStates.get(st) ?? 0) + 1);
      }
      throw new Error(
        `Timed out after ${timeoutMs / 1000}s with ${pendingIds.length} requests pending. Remaining: ${JSON.stringify(Object.fromEntries(remainingStates))}`,
      );
    }

    // Trigger batch runner periodically if autoBatch is enabled
    if (autoBatch && performance.now() - lastBatchTrigger > batchIntervalMs) {
      triggerBatch();
      lastBatchTrigger = performance.now();
    }

    // Poll a batch of pending requests concurrently
    const pollConcurrency = Math.min(C, 20);
    const checked = await mapConcurrent(pendingIds, pollConcurrency, async (id) => {
      try {
        const res = await fetch(`${base}/allocations/${id}`, {
          headers: { Authorization: `Bearer ${payrollToken}` },
        });
        if (res.status === 200) {
          const data = await res.json();
          return { id, data };
        }
      } catch {}
      return { id, data: null };
    });

    const stillPending = [];
    for (const { id, data } of checked) {
      if (data && FINAL_STATES.has(data.status)) {
        const item = resultsById.get(id);
        item.finalStatus = data.status;
        item.postingId = data.postingId ?? null;
        item.reason = data.reason ?? null;
        item.completedAt = performance.now();
        item.e2eLatency = item.completedAt - item.submittedAt;
      } else {
        stillPending.push(id);
      }
    }

    pendingIds = stillPending;
    if (pendingIds.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const allCompleted = Array.from(resultsById.values());
  const e2eLatencies = allCompleted.map((r) => r.e2eLatency);
  const e2eStats = stats(e2eLatencies);

  // 5. Counts per final status
  const statusCounts = {};
  for (const item of allCompleted) {
    statusCounts[item.finalStatus] = (statusCounts[item.finalStatus] ?? 0) + 1;
  }

  // 6. Zero duplicates verification
  const allocationIds = new Set();
  let duplicateAllocationIds = 0;
  for (const item of allCompleted) {
    if (allocationIds.has(item.id)) {
      duplicateAllocationIds++;
    }
    allocationIds.add(item.id);
  }

  const postingIds = new Set();
  let duplicatePostingIds = 0;
  for (const item of allCompleted) {
    if (item.postingId) {
      if (postingIds.has(item.postingId)) {
        duplicatePostingIds++;
      }
      postingIds.add(item.postingId);
    }
  }

  // Also query operations reconciliation endpoint to confirm zero duplicate postings across systems
  console.log("Checking operations reconciliation endpoint for cross-system consistency...");
  let recReport = null;
  try {
    const recRes = await fetch(`${base}/reconciliation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opsToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (recRes.status === 200) {
      recReport = (await recRes.json()).run;
    }
  } catch (err) {
    console.warn(`Warning: Could not fetch reconciliation report: ${err.message}`);
  }

  let highSeverityFindings = 0;
  let batchControlMismatches = 0;
  if (recReport && Array.isArray(recReport.findings)) {
    highSeverityFindings = recReport.findings.filter(
      (f) => f.severity === "HIGH",
    ).length;
    batchControlMismatches = recReport.findings.filter(
      (f) => f.code === "BATCH_CONTROL_MISMATCH",
    ).length;
  }

  // Assertions
  assert.equal(duplicateAllocationIds, 0, "Duplicate allocation IDs detected!");
  assert.equal(duplicatePostingIds, 0, "Duplicate posting IDs detected!");
  assert.equal(highSeverityFindings, 0, "High severity findings found in reconciliation!");
  assert.equal(batchControlMismatches, 0, "Batch control mismatches detected in reconciliation!");

  if (isReplay) {
    // Assert that replay mode produces exactly N postings
    const postedCount = statusCounts["POSTED"] ?? 0;
    assert.equal(
      postedCount,
      N,
      `Replay mode expected exactly ${N} POSTED allocations, but found ${postedCount}`,
    );
  }

  // 7. Print summary report
  console.log("\n=================================================");
  console.log("  Load Test Results");
  console.log("=================================================");
  console.log(`Unique Keys (N):        ${N}`);
  console.log(`Concurrency (C):        ${C}`);
  console.log(`Replay Mode:            ${isReplay ? "Enabled (2x concurrent requests per key)" : "Disabled"}`);
  console.log(`Total HTTP Requests:    ${totalHttpRequests}`);
  console.log(`Throughput:             ${throughput.toFixed(1)} req/s`);
  console.log("\n--- API Acceptance Latency (HTTP 202) ---");
  console.log(`p50:                    ${acceptanceStats.p50.toFixed(1)} ms`);
  console.log(`p95:                    ${acceptanceStats.p95.toFixed(1)} ms`);
  console.log(`p99:                    ${acceptanceStats.p99.toFixed(1)} ms`);
  console.log(`min:                    ${acceptanceStats.min.toFixed(1)} ms`);
  console.log(`max:                    ${acceptanceStats.max.toFixed(1)} ms`);
  console.log(`avg:                    ${acceptanceStats.avg.toFixed(1)} ms`);
  console.log("\n--- End-to-End Latency (to COBOL Final State) ---");
  console.log(`p50:                    ${(e2eStats.p50 / 1000).toFixed(2)} s (${e2eStats.p50.toFixed(0)} ms)`);
  console.log(`p95:                    ${(e2eStats.p95 / 1000).toFixed(2)} s (${e2eStats.p95.toFixed(0)} ms)`);
  console.log(`max:                    ${(e2eStats.max / 1000).toFixed(2)} s (${e2eStats.max.toFixed(0)} ms)`);
  console.log(`min:                    ${(e2eStats.min / 1000).toFixed(2)} s (${e2eStats.min.toFixed(0)} ms)`);
  console.log(`avg:                    ${(e2eStats.avg / 1000).toFixed(2)} s (${e2eStats.avg.toFixed(0)} ms)`);
  console.log("\n--- Final Status Breakdown ---");
  for (const [st, count] of Object.entries(statusCounts)) {
    console.log(`  ${st.padEnd(20)}: ${count}`);
  }
  console.log("\n--- Deduplication & Integrity ---");
  console.log(`Duplicate Allocations:  ${duplicateAllocationIds}`);
  console.log(`Duplicate Postings:     ${duplicatePostingIds}`);
  console.log(`High Severity Findings: ${highSeverityFindings}`);
  console.log(`Batch Mismatches:       ${batchControlMismatches}`);
  if (isReplay) {
    console.log(`Exact Postings Assert:  PASS (${statusCounts["POSTED"]} postings for ${2 * N} requests)`);
  }
  console.log("=================================================");
  console.log("PASS: Load test completed successfully with zero duplicates.");
}

main().catch((err) => {
  console.error("\nLOAD TEST FAILED:", err);
  process.exit(1);
});
