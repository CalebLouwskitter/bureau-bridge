import { connection, SqlStore } from "./store.ts";
import { env } from "./config.ts";
import { LegacyClient } from "./legacy.ts";
import { tick } from "./worker.ts";
import { reconcile } from "./reconciliation.ts";
const pool = await connection().connect();
const store = new SqlStore(pool),
  legacy = new LegacyClient(
    env("LEGACY_URL", "http://legacy:8080"),
    env("LEGACY_BRIDGE_KEY"),
  );
let running = true;
const interval = (name: string, fallback: string) => {
  const seconds = Number(env(name, fallback));
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 86400)
    throw new Error(`${name} must be between 5 and 86400 seconds`);
  return seconds * 1000;
};
const accountEvery = interval("ACCOUNT_SYNC_SECONDS", "30"),
  reconcileEvery = interval("RECONCILE_SECONDS", "300");
let nextAccounts = 0,
  nextReconciliation = 0;
process.once("SIGTERM", () => {
  running = false;
});
process.once("SIGINT", () => {
  running = false;
});
while (running) {
  try {
    if (Date.now() >= nextAccounts) {
      nextAccounts = Date.now() + accountEvery;
      await store.syncAccounts("INSURER_DEMO", await legacy.accounts());
    }
    if (Date.now() >= nextReconciliation) {
      nextReconciliation = Date.now() + reconcileEvery;
      await reconcile(store, legacy, "INSURER_DEMO");
    }
    if (await tick(store, legacy)) continue;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "worker",
        message: error instanceof Error ? error.message : "Worker failure",
      }),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await pool.close();
