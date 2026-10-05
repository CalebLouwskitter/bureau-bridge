import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expoCLI = resolve(
  dirname(require.resolve("expo/package.json")),
  "bin/cli",
);

// Override a phone's LAN API setting only for the test export. No .env is changed.
const exported = spawnSync(
  process.execPath,
  [expoCLI, "export", "--platform", "web"],
  {
    cwd: resolve(root, "apps/mobile"),
    env: {
      ...process.env,
      EXPO_PUBLIC_API_URL: "http://localhost:3000",
      EXPO_NO_TELEMETRY: "1",
      CI: "1",
    },
    stdio: "inherit",
  },
);
if (exported.status !== 0) process.exit(exported.status ?? 1);

const checked = spawnSync(
  process.execPath,
  [require.resolve("@playwright/test/cli"), "test", ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
  },
);
process.exit(checked.status ?? 1);
