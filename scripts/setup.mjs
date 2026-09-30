import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const env = join(root, ".env");
if (!existsSync(env)) {
  const secret = () => `Bb1!${randomBytes(24).toString("hex")}`;
  const keys = [
    "MSSQL_SA_PASSWORD",
    "MSSQL_PASSWORD",
    "LEGACY_DB_PASSWORD",
    "MARIADB_ROOT_PASSWORD",
    "LEGACY_BRIDGE_KEY",
    "LEGACY_OPS_KEY",
    "SESSION_SECRET",
    "DEMO_PASSWORD",
  ];
  writeFileSync(
    env,
    keys.map((key) => `${key}=${secret()}`).join("\n") +
      "\nAPI_BIND=127.0.0.1\nBATCH_TIMES=08:00,12:00,16:00,23:00\nCORS_ORIGINS=http://localhost:8081,http://localhost:19006\n",
    { mode: 0o600 },
  );
  console.log(
    "Created .env with independent local credentials. Find DEMO_PASSWORD there to sign in.",
  );
} else console.log("Existing .env preserved.");
const mobile = join(root, "apps/mobile/.env");
mkdirSync(join(root, "apps/mobile"), { recursive: true });
if (!existsSync(mobile))
  writeFileSync(
    mobile,
    "# Physical phone: set your computer LAN address, then restart Expo.\n# EXPO_PUBLIC_API_URL=http://192.168.1.100:3000\n",
  );
console.log("Next: docker compose up --build -d");
