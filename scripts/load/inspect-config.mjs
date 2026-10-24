#!/usr/bin/env node
/**
 * Configuration & parameter inspection script for BureauBridge load testing.
 * Inspects whether batch size and worker poll interval are configurable in production code,
 * and records default operational parameters across the stack.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

function checkFile(path, regex) {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) return { found: false, matches: [] };
  const content = readFileSync(fullPath, "utf8");
  const matches = [...content.matchAll(regex)];
  return { found: true, matches: matches.map((m) => m[0]) };
}

const parameters = [
  {
    parameter: "Legacy Batch Size",
    subsystem: "PHP Intake (MariaDB)",
    file: "legacy/php/lib.php",
    search: /LIMIT\s+100\s+FOR\s+UPDATE/g,
    defaultValue: "100 records per batch",
    configurable: false,
    mechanism: "Hardcoded in SQL query (`LIMIT 100 FOR UPDATE`)",
  },
  {
    parameter: "Worker Idle Poll Interval",
    subsystem: "TypeScript Worker",
    file: "services/server/src/worker-main.ts",
    search: /setTimeout\(resolve,\s*1000\)/g,
    defaultValue: "1000 ms (1 second)",
    configurable: false,
    mechanism: "Hardcoded in main event loop (`setTimeout(resolve, 1000)`)",
  },
  {
    parameter: "Worker Outbox Re-poll Delay",
    subsystem: "SQL Server Outbox Store",
    file: "services/server/src/store.ts",
    search: /DATEADD\(SECOND,3,SYSUTCDATETIME\(\)\)/g,
    defaultValue: "3 seconds",
    configurable: false,
    mechanism: "Hardcoded in T-SQL `finish` update for non-terminal jobs",
  },
  {
    parameter: "Legacy Scheduler Batch Slots",
    subsystem: "Python Scheduler",
    file: "legacy/scheduler.py",
    search: /BATCH_TIMES.*08:00,12:00,16:00,23:00/g,
    defaultValue: "08:00, 12:00, 16:00, 23:00 (Africa/Johannesburg)",
    configurable: true,
    mechanism: "Configurable via `BATCH_TIMES` environment variable",
  },
  {
    parameter: "Scheduler Loop Interval",
    subsystem: "Python Scheduler",
    file: "legacy/scheduler.py",
    search: /time\.sleep\(10\)/g,
    defaultValue: "10 seconds",
    configurable: false,
    mechanism: "Hardcoded loop sleep (`time.sleep(10)`)",
  },
  {
    parameter: "Worker Account Projection Sync",
    subsystem: "TypeScript Worker",
    file: "services/server/src/worker-main.ts",
    search: /ACCOUNT_SYNC_SECONDS.*30/g,
    defaultValue: "30 seconds",
    configurable: true,
    mechanism: "Configurable via `ACCOUNT_SYNC_SECONDS` environment variable",
  },
  {
    parameter: "Worker Reconciliation Interval",
    subsystem: "TypeScript Worker",
    file: "services/server/src/worker-main.ts",
    search: /RECONCILE_SECONDS.*300/g,
    defaultValue: "300 seconds (5 minutes)",
    configurable: true,
    mechanism: "Configurable via `RECONCILE_SECONDS` environment variable",
  },
  {
    parameter: "API Rate Limit",
    subsystem: "Fastify API",
    file: "services/server/src/app.ts",
    search: /rateLimit.*max:\s*120,\s*timeWindow:\s*"1 minute"/g,
    defaultValue: "120 requests / minute",
    configurable: false,
    mechanism: "Hardcoded in Fastify `@fastify/rate-limit` registration",
  },
  {
    parameter: "Reconciliation Scan Limit",
    subsystem: "PHP / TypeScript Reconciliation",
    file: "services/server/src/reconciliation.ts",
    search: /5000/g,
    defaultValue: "5,000 records",
    configurable: false,
    mechanism: "Hardcoded audit limit across PHP and TypeScript stores",
  },
  {
    parameter: "Total Prefund Balance",
    subsystem: "COBOL Ledger / Python Runner",
    file: "legacy/core-runner.py",
    search: /10000000/g,
    defaultValue: "10,000,000 cents (R100,000.00)",
    configurable: false,
    mechanism: "Fixed conservation assertion across all accounts",
  },
];

console.log("================================================================================");
console.log("  BureauBridge Stack Configuration & Parameter Readout");
console.log("================================================================================");

for (const p of parameters) {
  const result = checkFile(p.file, p.search);
  const status = p.configurable ? "CONFIGURABLE (ENV)" : "HARDCODED (FIXED)";
  console.log(`\n* Parameter:    ${p.parameter}`);
  console.log(`  Subsystem:    ${p.subsystem} (${p.file})`);
  console.log(`  Default:      ${p.defaultValue}`);
  console.log(`  Status:       ${status}`);
  console.log(`  Mechanism:    ${p.mechanism}`);
  console.log(`  Verified:     ${result.matches.length > 0 ? "YES" : "NO"}`);
}

console.log("\n================================================================================");
console.log("Summary for Batch-Size Experiment:");
console.log("- Neither batch size (100 items) nor worker poll interval (1000 ms) is configurable");
console.log("  via environment variables or runtime configuration.");
console.log("- Per task rules: do not add configuration to production code; record the default.");
console.log("================================================================================");
