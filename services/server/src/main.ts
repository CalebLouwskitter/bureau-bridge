import { connection, SqlStore } from "./store.ts";
import { env } from "./config.ts";
import { LegacyClient } from "./legacy.ts";
import { makeApp } from "./app.ts";
const pool = await connection().connect();
const app = makeApp(
  new SqlStore(pool),
  new LegacyClient(
    env("LEGACY_URL", "http://legacy:8080"),
    env("LEGACY_BRIDGE_KEY"),
    env("LEGACY_OPS_KEY"),
  ),
  {
    sessionSecret: env("SESSION_SECRET"),
    demoPassword: env("DEMO_PASSWORD"),
    logger: true,
    origins: env(
      "CORS_ORIGINS",
      "http://localhost:8081,http://localhost:19006",
    ).split(","),
    health: async () => {
      await pool.request().query("SELECT 1");
    },
  },
);
async function stop() {
  await app.close();
  await pool.close();
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
await app.listen({ host: "0.0.0.0", port: Number(env("PORT", "3000")) });
