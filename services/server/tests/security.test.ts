import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  issue,
  JWT_ALGORITHM,
  JwtKeySet,
  verify,
} from "../src/auth.ts";
import {
  computeContentDigest,
  signHttpRequest,
  verifyHttpRequest,
} from "../src/http-signature.ts";
import { makeApp } from "../src/app.ts";
import { MemoryStore } from "../src/store.ts";
import type { Legacy } from "../src/legacy.ts";

test("asymmetric EdDSA JWT supports kid lookup, JWKS export, and zero-downtime key rotation", async () => {
  const keySet = JwtKeySet.generate("key-v1");
  const tokenV1 = issue("ops", keySet, 1_000_000)!;

  // Standard 3-part JWT with EdDSA algorithm and kid header
  const parts = tokenV1.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  assert.deepEqual(header, { alg: JWT_ALGORITHM, typ: "JWT", kid: "key-v1" });
  assert.equal(verify(tokenV1, keySet, 1_000_000)?.username, "ops");

  // JWKS exposes public key material only (no private 'd' parameter)
  const jwks1 = keySet.publicJwks();
  assert.equal(jwks1.keys.length, 1);
  assert.equal(jwks1.keys[0].kid, "key-v1");
  assert.equal(jwks1.keys[0].crv, "Ed25519");
  assert.equal("d" in jwks1.keys[0], false);

  // Rotate to key-v2: both v1 and v2 tokens verify during transition
  keySet.rotate("key-v2");
  const tokenV2 = issue("insurer-admin", keySet, 1_000_000)!;
  const headerV2 = JSON.parse(
    Buffer.from(tokenV2.split(".")[0], "base64url").toString("utf8"),
  );
  assert.equal(headerV2.kid, "key-v2");
  assert.equal(verify(tokenV1, keySet, 1_000_000)?.username, "ops");
  assert.equal(verify(tokenV2, keySet, 1_000_000)?.username, "insurer-admin");
  assert.equal(keySet.publicJwks().keys.length, 2);

  // Revoke key-v1: old tokens fail while key-v2 remains valid
  assert.equal(keySet.revokeKey("key-v1"), true);
  assert.equal(verify(tokenV1, keySet, 1_000_000), undefined);
  assert.equal(verify(tokenV2, keySet, 1_000_000)?.username, "insurer-admin");

  // /.well-known/jwks.json exposes active JWKS over HTTP without auth
  const app = makeApp(new MemoryStore(), {} as Legacy, {
    sessionSecret: "unused-when-keyset-supplied",
    jwtKeySet: keySet,
    demoPassword: "pw",
  });
  const jwksRes = await app.inject({
    method: "GET",
    url: "/.well-known/jwks.json",
  });
  assert.equal(jwksRes.statusCode, 200);
  assert.equal(jwksRes.json().keys.length, 1);
  assert.equal(jwksRes.json().keys[0].kid, "key-v2");
  await app.close();
});

test("JWT verification strictly pins EdDSA and rejects alg:none, HS256 confusion, unknown kid, and tampering", () => {
  const keySet = JwtKeySet.generate("key-strict");
  const now = 2_000_000;
  const payloadB64 = Buffer.from(
    JSON.stringify({
      sub: "ops",
      role: "ops",
      clientId: "INSURER_DEMO",
      iss: "bureau-bridge",
      aud: "bureau-api",
      iat: Math.floor(now / 1000),
      nbf: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 3600,
    }),
  ).toString("base64url");

  // 1. alg: "none" attack
  const noneHeader = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT", kid: "key-strict" }),
  ).toString("base64url");
  assert.equal(verify(`${noneHeader}.${payloadB64}.`, keySet, now), undefined);

  // 2. HS256 algorithm confusion using public JWK x value as HMAC key
  const hsHeader = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT", kid: "key-strict" }),
  ).toString("base64url");
  const hsSig = createHmac("sha256", keySet.publicJwks().keys[0].x)
    .update(`${hsHeader}.${payloadB64}`)
    .digest("base64url");
  assert.equal(
    verify(`${hsHeader}.${payloadB64}.${hsSig}`, keySet, now),
    undefined,
  );

  // 3. Unknown kid rejected
  const otherKey = JwtKeySet.generate("unknown-kid");
  const foreignToken = issue("ops", otherKey, now)!;
  assert.equal(verify(foreignToken, keySet, now), undefined);

  // 4. Demo secret mode rejects old 2-part HMAC body.sig tokens
  const legacyHmac =
    payloadB64 +
    "." +
    createHmac("sha256", "demo-secret").update(payloadB64).digest("base64url");
  assert.equal(verify(legacyHmac, "demo-secret", now), undefined);
});

test("RFC 9421 HTTP message signing verifies valid requests and rejects tampered payloads, URIs, methods, and stale timestamps", () => {
  const secret = "bridge-signing-secret";
  const targetUri = "http://legacy:8080/v1/requests";
  const body = JSON.stringify({
    reference: randomUUID(),
    sourceAccount: "INS000000001",
    targetAccount: "EMP000000001",
    amountMinor: 25_000,
    currency: "ZAR",
  });
  const nowSec = 1_750_000_000;

  const headers = signHttpRequest({
    method: "POST",
    targetUri,
    body,
    keyId: "bridge",
    secret,
    created: nowSec,
  });

  // Valid request at t=0 and at ±60s boundary
  assert.deepEqual(
    verifyHttpRequest({
      method: "POST",
      targetUri,
      body,
      headers,
      expectedKeyId: "bridge",
      secret,
      nowSeconds: nowSec,
    }),
    { ok: true, created: nowSec, keyId: "bridge" },
  );
  assert.equal(
    verifyHttpRequest({
      method: "POST",
      targetUri,
      body,
      headers,
      expectedKeyId: "bridge",
      secret,
      nowSeconds: nowSec + 60,
    }).ok,
    true,
  );

  // Rejects expired (>60s old) and future (>60s ahead) timestamps
  const expired = verifyHttpRequest({
    method: "POST",
    targetUri,
    body,
    headers,
    expectedKeyId: "bridge",
    secret,
    nowSeconds: nowSec + 61,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.ok ? "" : expired.reason, "TIMESTAMP_OUT_OF_WINDOW");

  const future = verifyHttpRequest({
    method: "POST",
    targetUri,
    body,
    headers,
    expectedKeyId: "bridge",
    secret,
    nowSeconds: nowSec - 61,
  });
  assert.equal(future.ok, false);

  // Rejects tampered payload body (Content-Digest mismatch)
  const tamperedBody = body.replace("25000", "99999");
  const digestFail = verifyHttpRequest({
    method: "POST",
    targetUri,
    body: tamperedBody,
    headers,
    expectedKeyId: "bridge",
    secret,
    nowSeconds: nowSec,
  });
  assert.equal(digestFail.ok, false);
  assert.equal(digestFail.ok ? "" : digestFail.reason, "CONTENT_DIGEST_MISMATCH");

  // Rejects tampered payload EVEN IF attacker recomputes Content-Digest (Signature mismatch)
  const rehashed = {
    ...headers,
    "Content-Digest": computeContentDigest(tamperedBody),
  };
  const sigFail = verifyHttpRequest({
    method: "POST",
    targetUri,
    body: tamperedBody,
    headers: rehashed,
    expectedKeyId: "bridge",
    secret,
    nowSeconds: nowSec,
  });
  assert.equal(sigFail.ok, false);
  assert.equal(sigFail.ok ? "" : sigFail.reason, "SIGNATURE_MISMATCH");

  // Rejects altered @target-uri or @method
  assert.equal(
    verifyHttpRequest({
      method: "POST",
      targetUri: "http://legacy:8080/v1/requests/other",
      body,
      headers,
      expectedKeyId: "bridge",
      secret,
      nowSeconds: nowSec,
    }).ok,
    false,
  );
  assert.equal(
    verifyHttpRequest({
      method: "GET",
      targetUri,
      body,
      headers,
      expectedKeyId: "bridge",
      secret,
      nowSeconds: nowSec,
    }).ok,
    false,
  );

  // Rejects keyId mismatch (e.g. bridge key used against ops endpoint)
  assert.equal(
    verifyHttpRequest({
      method: "POST",
      targetUri,
      body,
      headers,
      expectedKeyId: "ops",
      secret,
      nowSeconds: nowSec,
    }).ok,
    false,
  );
});

test("TypeScript RFC 9421 signatures verify cleanly in PHP legacy/php/lib.php", (t) => {
  const phpCheck = spawnSync("php", ["-v"], { encoding: "utf8" });
  if (phpCheck.status !== 0) {
    t.skip("PHP CLI not available");
    return;
  }
  const libPath = fileURLToPath(
    new URL("../../../legacy/php/lib.php", import.meta.url),
  );
  const secret = "shared-interop-secret-123";
  const targetUri = "http://legacy:8080/v1/requests";
  const body = JSON.stringify({
    reference: "7e9c52fe-7bb7-4b15-9c87-ec16d001b34c",
    sourceAccount: "INS000000001",
    targetAccount: "EMP000000001",
    amountMinor: 25_000,
    currency: "ZAR",
  });
  const created = 1_750_000_000;
  const headers = signHttpRequest({
    method: "POST",
    targetUri,
    body,
    keyId: "bridge",
    secret,
    created,
  });

  const phpScript = `
    require ${JSON.stringify(libPath)};
    $okValid = verify_http_signature('POST', ${JSON.stringify(targetUri)}, ${JSON.stringify(body)}, ${JSON.stringify(headers["Signature-Input"])}, ${JSON.stringify(headers.Signature)}, ${JSON.stringify(headers["Content-Digest"])}, 'bridge', ${JSON.stringify(secret)}, ${created});
    $okTampered = verify_http_signature('POST', ${JSON.stringify(targetUri)}, ${JSON.stringify(body.replace("25000", "25001"))}, ${JSON.stringify(headers["Signature-Input"])}, ${JSON.stringify(headers.Signature)}, ${JSON.stringify(headers["Content-Digest"])}, 'bridge', ${JSON.stringify(secret)}, ${created});
    $okExpired = verify_http_signature('POST', ${JSON.stringify(targetUri)}, ${JSON.stringify(body)}, ${JSON.stringify(headers["Signature-Input"])}, ${JSON.stringify(headers.Signature)}, ${JSON.stringify(headers["Content-Digest"])}, 'bridge', ${JSON.stringify(secret)}, ${created + 61});
    echo json_encode(['valid' => $okValid, 'tampered' => $okTampered, 'expired' => $okExpired]);
  `;
  const run = spawnSync("php", ["-r", phpScript], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    valid: true,
    tampered: false,
    expired: false,
  });
});
