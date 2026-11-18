import { connection } from "./store.ts";
import { SqlPayoutStore } from "./payout-store.ts";
import { BankClient } from "./payouts.ts";
import { env } from "./config.ts";
import { LegacyClient } from "./legacy.ts";
import { JwtKeySet, type JwksDocument } from "./auth.ts";
import { makeApp } from "./app.ts";
const pool = await connection().connect();
const store = new SqlPayoutStore(pool);
const sessionSecret = env("SESSION_SECRET");
const jwtKeySet = process.env.JWT_PRIVATE_KEY_PEM
  ? JwtKeySet.fromPem(
      process.env.JWT_PRIVATE_KEY_PEM,
      process.env.JWT_KID ?? "primary",
      process.env.JWT_JWKS_JSON
        ? (JSON.parse(process.env.JWT_JWKS_JSON) as JwksDocument)
        : undefined,
    )
  : JwtKeySet.fromDemoSecret(sessionSecret);
const app = makeApp(
  store,
  new LegacyClient(
    env("LEGACY_URL", "http://legacy:8080"),
    env("LEGACY_BRIDGE_KEY"),
    env("LEGACY_OPS_KEY"),
  ),
  {
    sessionSecret,
    jwtKeySet,
    demoPassword: env("DEMO_PASSWORD"),
    logger: true,
    payouts: {
      store,
      bank: new BankClient(
        env("BANK_URL", "http://bank:3100"),
        env("BANK_KEY"),
      ),
    },
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
