import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
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
  "ops-two": { username: "ops-two", role: "ops", clientId: "INSURER_DEMO" },
};

export const JWT_ALGORITHM = "EdDSA" as const;
export const JWT_ISSUER = "bureau-bridge";
export const JWT_AUDIENCE = "bureau-api";

// RFC 8410 ASN.1 PKCS#8 prefix for a 32-byte Ed25519 private key seed.
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export interface JwkPublicKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  alg: typeof JWT_ALGORITHM;
}

export interface JwksDocument {
  keys: JwkPublicKey[];
}

interface SigningKeyEntry {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: JwkPublicKey;
}

function exportPublicJwk(publicKey: KeyObject, kid: string): JwkPublicKey {
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Only Ed25519 keys are supported for JWT signing");
  }
  const exported = publicKey.export({ format: "jwk" }) as {
    kty?: string;
    crv?: string;
    x?: string;
  };
  if (
    exported.kty !== "OKP" ||
    exported.crv !== "Ed25519" ||
    typeof exported.x !== "string"
  ) {
    throw new Error("Invalid Ed25519 public JWK");
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: exported.x,
    kid,
    use: "sig",
    alg: JWT_ALGORITHM,
  };
}

function deriveEd25519KeyFromSecret(
  secret: string,
  kid: string,
): SigningKeyEntry {
  const seed = Buffer.from(
    hkdfSync("sha256", secret, "bureau-bridge-jwt-ed25519-v1", kid, 32),
  );
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = createPrivateKey({
    key: pkcs8Der,
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  return {
    kid,
    privateKey,
    publicKey,
    jwk: exportPublicJwk(publicKey, kid),
  };
}

const demoKeyCache = new Map<string, JwtKeySet>();

export class JwtKeySet {
  private active: SigningKeyEntry;
  private readonly verificationKeys = new Map<
    string,
    { publicKey: KeyObject; jwk: JwkPublicKey }
  >();

  private constructor(initial: SigningKeyEntry) {
    this.active = initial;
    this.verificationKeys.set(initial.kid, {
      publicKey: initial.publicKey,
      jwk: initial.jwk,
    });
  }

  /**
   * Deterministic local dev/demo key-pair mode derived from SESSION_SECRET so
   * zero-config local runs and smoke tests sign & verify real Ed25519 JWTs.
   */
  static fromDemoSecret(secret: string, kid?: string): JwtKeySet {
    const derivedKid =
      kid ??
      "demo-" +
        createHash("sha256")
          .update(`bureau-kid:${secret}`)
          .digest("hex")
          .slice(0, 12);
    const cacheKey = `${derivedKid}:${createHash("sha256").update(secret).digest("hex")}`;
    let cached = demoKeyCache.get(cacheKey);
    if (!cached) {
      cached = new JwtKeySet(deriveEd25519KeyFromSecret(secret, derivedKid));
      if (demoKeyCache.size > 64) demoKeyCache.clear();
      demoKeyCache.set(cacheKey, cached);
    }
    return cached;
  }

  static generate(kid = `key-${randomBytes(6).toString("hex")}`): JwtKeySet {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return new JwtKeySet({
      kid,
      privateKey,
      publicKey,
      jwk: exportPublicJwk(publicKey, kid),
    });
  }

  static fromPem(
    privatePem: string,
    kid: string,
    additionalJwks?: JwksDocument,
  ): JwtKeySet {
    const privateKey = createPrivateKey(privatePem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("JWT_PRIVATE_KEY_PEM must be an Ed25519 private key");
    }
    const publicKey = createPublicKey(privateKey);
    const set = new JwtKeySet({
      kid,
      privateKey,
      publicKey,
      jwk: exportPublicJwk(publicKey, kid),
    });
    if (additionalJwks?.keys) {
      for (const jwk of additionalJwks.keys) {
        if (jwk.kid !== kid) set.addVerificationJwk(jwk);
      }
    }
    return set;
  }

  get activeKid(): string {
    return this.active.kid;
  }

  addVerificationJwk(jwk: JwkPublicKey): void {
    if (
      jwk.kty !== "OKP" ||
      jwk.crv !== "Ed25519" ||
      jwk.alg !== JWT_ALGORITHM ||
      typeof jwk.kid !== "string" ||
      !jwk.kid ||
      typeof jwk.x !== "string"
    ) {
      throw new Error("Unsupported JWK; only Ed25519 (EdDSA) public keys allowed");
    }
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: jwk.x },
      format: "jwk",
    });
    this.verificationKeys.set(jwk.kid, {
      publicKey,
      jwk: exportPublicJwk(publicKey, jwk.kid),
    });
  }

  /**
   * Generates and activates a new signing key while keeping previous public keys
   * in the JWKS set so existing tokens remain valid until expiry.
   */
  rotate(kid = `key-${randomBytes(6).toString("hex")}`): string {
    if (this.verificationKeys.has(kid)) {
      throw new Error(`Key id ${kid} already exists in key set`);
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const entry: SigningKeyEntry = {
      kid,
      privateKey,
      publicKey,
      jwk: exportPublicJwk(publicKey, kid),
    };
    this.active = entry;
    this.verificationKeys.set(kid, {
      publicKey: entry.publicKey,
      jwk: entry.jwk,
    });
    return kid;
  }

  revokeKey(kid: string): boolean {
    if (kid === this.active.kid) {
      throw new Error("Rotate to a new active signing key before revoking current kid");
    }
    return this.verificationKeys.delete(kid);
  }

  publicJwks(): JwksDocument {
    return {
      keys: Array.from(this.verificationKeys.values()).map((entry) => ({
        ...entry.jwk,
      })),
    };
  }

  sign(principal: Principal, now = Date.now(), ttlSeconds = 3600): string {
    const iat = Math.floor(now / 1000);
    const header = Buffer.from(
      JSON.stringify({
        alg: JWT_ALGORITHM,
        typ: "JWT",
        kid: this.active.kid,
      }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: principal.username,
        role: principal.role,
        clientId: principal.clientId,
        ...(principal.employeeAccount
          ? { employeeAccount: principal.employeeAccount }
          : {}),
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        iat,
        nbf: iat,
        exp: iat + ttlSeconds,
      }),
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const sig = cryptoSign(
      null,
      Buffer.from(signingInput, "ascii"),
      this.active.privateKey,
    ).toString("base64url");
    return `${signingInput}.${sig}`;
  }

  verify(token: string, now = Date.now()): Principal | undefined {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const [headerB64, payloadB64, sigB64] = parts;
    if (!headerB64 || !payloadB64 || !sigB64) return undefined;

    let header: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }

    // Strict algorithm pinning: only EdDSA with typ=JWT and known kid accepted.
    if (
      !header ||
      typeof header !== "object" ||
      header.alg !== JWT_ALGORITHM ||
      header.typ !== "JWT" ||
      typeof header.kid !== "string" ||
      !header.kid
    ) {
      return undefined;
    }

    const keyEntry = this.verificationKeys.get(header.kid);
    if (!keyEntry) return undefined;

    let sigBytes: Buffer;
    try {
      sigBytes = Buffer.from(sigB64, "base64url");
      // Guard against non-canonical trailing garbage on base64url signatures.
      if (sigBytes.length !== 64 || sigBytes.toString("base64url") !== sigB64) {
        return undefined;
      }
    } catch {
      return undefined;
    }

    const valid = cryptoVerify(
      null,
      Buffer.from(`${headerB64}.${payloadB64}`, "ascii"),
      keyEntry.publicKey,
      sigBytes,
    );
    if (!valid) return undefined;

    try {
      const data = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const nowSec = Math.floor(now / 1000);
      if (
        typeof data.sub !== "string" ||
        !Object.hasOwn(users, data.sub) ||
        data.iss !== JWT_ISSUER ||
        data.aud !== JWT_AUDIENCE ||
        typeof data.exp !== "number" ||
        data.exp <= nowSec ||
        (typeof data.nbf === "number" && data.nbf > nowSec)
      ) {
        return undefined;
      }
      return users[data.sub];
    } catch {
      return undefined;
    }
  }
}

export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function resolveKeySet(secretOrKeySet: string | JwtKeySet): JwtKeySet {
  return typeof secretOrKeySet === "string"
    ? JwtKeySet.fromDemoSecret(secretOrKeySet)
    : secretOrKeySet;
}

export function issue(
  username: string,
  secretOrKeySet: string | JwtKeySet,
  now = Date.now(),
): string | undefined {
  if (!Object.hasOwn(users, username)) return undefined;
  return resolveKeySet(secretOrKeySet).sign(users[username], now);
}

export function verify(
  token: string,
  secretOrKeySet: string | JwtKeySet,
  now = Date.now(),
): Principal | undefined {
  return resolveKeySet(secretOrKeySet).verify(token, now);
}
