import { createHmac, timingSafeEqual } from "node:crypto";
import type { Principal } from "@bureau/contracts";
const users: Record<string, Principal> = {
  "insurer-admin": {
    username: "insurer-admin",
    role: "payroll",
    clientId: "INSURER_DEMO",
  },
  "employee-one": {
    username: "employee-one",
    role: "employee",
    clientId: "INSURER_DEMO",
    employeeAccount: "EMP000000001",
  },
  ops: { username: "ops", role: "ops", clientId: "INSURER_DEMO" },
};
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function issue(
  username: string,
  secret: string,
  now = Date.now(),
): string | undefined {
  if (!Object.hasOwn(users, username)) return undefined;
  const body = Buffer.from(
    JSON.stringify({ sub: username, exp: Math.floor(now / 1000) + 3600 }),
  ).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export function verify(
  token: string,
  secret: string,
  now = Date.now(),
): Principal | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [body, signature] = parts;
  if (
    !equal(
      signature,
      createHmac("sha256", secret).update(body).digest("base64url"),
    )
  )
    return undefined;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    return typeof data.sub === "string" &&
      Object.hasOwn(users, data.sub) &&
      typeof data.exp === "number" &&
      data.exp > Math.floor(now / 1000)
      ? users[data.sub]
      : undefined;
  } catch {
    return undefined;
  }
}
