import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const HTTP_SIGNATURE_WINDOW_SECONDS = 60;
export const HTTP_SIGNATURE_LABEL = "sig1";
export const HTTP_SIGNATURE_ALG = "hmac-sha256";

export interface SignHttpRequestParams {
  method: string;
  targetUri: string;
  body?: string | Buffer;
  keyId: string;
  secret: string;
  created?: number; // Unix timestamp in seconds
}

export type SignedHttpHeaders = {
  "Content-Digest": string;
  "Signature-Input": string;
  Signature: string;
};

export function computeContentDigest(body: string | Buffer = ""): string {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const digest = createHash("sha256").update(bytes).digest("base64");
  return `sha-256=:${digest}:`;
}

export function buildSignatureParams(created: number, keyId: string): string {
  return `("@method" "@target-uri" "content-digest");created=${created};keyid="${keyId}";alg="${HTTP_SIGNATURE_ALG}"`;
}

export function buildSignatureBase(params: {
  method: string;
  targetUri: string;
  contentDigest: string;
  signatureParams: string;
}): string {
  return [
    `"@method": ${params.method.toUpperCase()}`,
    `"@target-uri": ${params.targetUri}`,
    `"content-digest": ${params.contentDigest}`,
    `"@signature-params": ${params.signatureParams}`,
  ].join("\n");
}

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signHttpRequest(params: SignHttpRequestParams): SignedHttpHeaders {
  const created = params.created ?? Math.floor(Date.now() / 1000);
  const contentDigest = computeContentDigest(params.body ?? "");
  const signatureParams = buildSignatureParams(created, params.keyId);
  const base = buildSignatureBase({
    method: params.method,
    targetUri: params.targetUri,
    contentDigest,
    signatureParams,
  });
  const mac = createHmac("sha256", params.secret)
    .update(base, "utf8")
    .digest("base64");
  return {
    "Content-Digest": contentDigest,
    "Signature-Input": `${HTTP_SIGNATURE_LABEL}=${signatureParams}`,
    Signature: `${HTTP_SIGNATURE_LABEL}=:${mac}:`,
  };
}

export interface VerifyHttpRequestParams {
  method: string;
  targetUri: string;
  body?: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  expectedKeyId: string;
  secret: string;
  nowSeconds?: number;
  windowSeconds?: number;
}

export type VerifyHttpResult =
  | { ok: true; created: number; keyId: string }
  | { ok: false; reason: string };

const SIG_INPUT_RE =
  /^sig1=(\("@method" "@target-uri" "content-digest"\);created=(\d{1,12});keyid="([a-z0-9_-]+)";alg="hmac-sha256")$/;

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

export function verifyHttpRequest(
  params: VerifyHttpRequestParams,
): VerifyHttpResult {
  const sigInput = getHeader(params.headers, "signature-input")?.trim();
  const signature = getHeader(params.headers, "signature")?.trim();
  const contentDigest = getHeader(params.headers, "content-digest")?.trim();

  if (!sigInput || !signature || !contentDigest) {
    return { ok: false, reason: "MISSING_SIGNATURE_HEADERS" };
  }

  const match = SIG_INPUT_RE.exec(sigInput);
  if (!match) {
    return { ok: false, reason: "INVALID_SIGNATURE_INPUT" };
  }
  const [, signatureParams, createdStr, keyId] = match;
  if (keyId !== params.expectedKeyId) {
    return { ok: false, reason: "KEY_ID_MISMATCH" };
  }

  const created = Number(createdStr);
  const nowSec = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const windowSec = params.windowSeconds ?? HTTP_SIGNATURE_WINDOW_SECONDS;
  if (!Number.isSafeInteger(created) || Math.abs(nowSec - created) > windowSec) {
    return { ok: false, reason: "TIMESTAMP_OUT_OF_WINDOW" };
  }

  const expectedDigest = computeContentDigest(params.body ?? "");
  if (!constantTimeEquals(expectedDigest, contentDigest)) {
    return { ok: false, reason: "CONTENT_DIGEST_MISMATCH" };
  }

  const base = buildSignatureBase({
    method: params.method,
    targetUri: params.targetUri,
    contentDigest,
    signatureParams,
  });
  const expectedMac = createHmac("sha256", params.secret)
    .update(base, "utf8")
    .digest("base64");
  const expectedSig = `${HTTP_SIGNATURE_LABEL}=:${expectedMac}:`;

  if (!constantTimeEquals(expectedSig, signature)) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }

  return { ok: true, created, keyId };
}
