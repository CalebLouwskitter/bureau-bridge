import { UUID, type Allocation, type AccountSnapshot } from "@bureau/contracts";
import {
  CircuitBreaker,
  executeResilient,
  LegacyHttpError,
  LegacyInvariantError,
  RetryBudget,
  type CircuitBreakerOptions,
  type RetryPolicyOptions,
} from "./resilience.ts";
import { signHttpRequest } from "./http-signature.ts";
export interface LegacyResult {
  reference: string;
  status: string;
  sourceAccount: string;
  targetAccount: string;
  amountMinor: number;
  currency: string;
  reason: string | null;
  postingId: string | null;
  createdAt?: string;
}
export interface BatchControl {
  id: string;
  control_match: boolean;
  unresolved_count: number;
  record_count: number;
  amount_total: number;
  submitted_count: number;
  submitted_total: number;
}
export interface LegacyInventory {
  requests: LegacyResult[];
  batches: BatchControl[];
  core: {
    records: LegacyResult[];
    balances: AccountSnapshot["balances"];
    generation: string;
    observedAt: string;
    truncated: boolean;
  };
  truncated: boolean;
}
export interface LegacyCallOptions {
  fencingToken?: number;
  traceparent?: string | null;
}
export interface Legacy {
  lookup(
    id: string,
    opts?: LegacyCallOptions,
  ): Promise<LegacyResult | undefined>;
  submit(
    allocation: Allocation,
    opts?: LegacyCallOptions,
  ): Promise<LegacyResult>;
  inquire(id: string, opts?: LegacyCallOptions): Promise<unknown>;
  retryUnposted(id: string, opts?: LegacyCallOptions): Promise<unknown>;
  accounts(opts?: LegacyCallOptions): Promise<AccountSnapshot>;
  inventory(opts?: LegacyCallOptions): Promise<LegacyInventory>;
}
export interface LegacyClientTimeouts {
  lookup?: number;
  submit?: number;
  inquire?: number;
  retry?: number;
  accounts?: number;
  inventory?: number;
}
export interface LegacyClientOptions {
  timeouts?: LegacyClientTimeouts;
  circuitBreaker?: CircuitBreaker | CircuitBreakerOptions;
  retry?: RetryPolicyOptions;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
export class LegacyClient implements Legacy {
  readonly breaker: CircuitBreaker;
  private readonly retryPolicy: RetryPolicyOptions;
  private readonly timeouts: Required<LegacyClientTimeouts>;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly nowFn: () => number;

  constructor(
    private base: string,
    private bridgeKey: string,
    private opsKey?: string,
    options: LegacyClientOptions = {},
  ) {
    this.breaker =
      options.circuitBreaker instanceof CircuitBreaker
        ? options.circuitBreaker
        : new CircuitBreaker({
            failureThreshold: 5,
            halfOpenAfterMs: 30_000,
            ...options.circuitBreaker,
          });
    this.retryPolicy = {
      maxAttempts: 3,
      baseDelayMs: 150,
      maxDelayMs: 2_000,
      budget: options.retry?.budget ?? new RetryBudget(),
      ...options.retry,
    };
    this.timeouts = {
      lookup: options.timeouts?.lookup ?? 4_000,
      submit: options.timeouts?.submit ?? 8_000,
      inquire: options.timeouts?.inquire ?? 8_000,
      retry: options.timeouts?.retry ?? 8_000,
      accounts: options.timeouts?.accounts ?? 4_000,
      inventory: options.timeouts?.inventory ?? 10_000,
    };
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.nowFn = options.now ?? (() => Date.now());
  }
  private async call(
    path: string,
    method = "GET",
    body?: unknown,
    ops = false,
    opts?: LegacyCallOptions,
    timeoutMs = this.timeouts.lookup,
  ) {
    const targetUri = new URL(path, this.base.replace(/\/+$/, "") + "/").toString();
    const serializedBody = body !== undefined ? JSON.stringify(body) : undefined;
    const keyId = ops ? "ops" : "bridge";
    const secret = ops ? this.opsKey : this.bridgeKey;
    if (!secret) {
      throw new LegacyInvariantError(
        ops ? "MISSING_LEGACY_OPS_KEY" : "MISSING_LEGACY_BRIDGE_KEY",
      );
    }
    return executeResilient(
      async (signal) => {
        const signed = signHttpRequest({
          method,
          targetUri,
          body: serializedBody ?? "",
          keyId,
          secret,
          created: Math.floor(this.nowFn() / 1000),
        });
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...signed,
        };
        if (opts?.fencingToken !== undefined) {
          headers["X-Fencing-Token"] = String(opts.fencingToken);
        }
        if (opts?.traceparent) {
          headers["traceparent"] = opts.traceparent;
        }
        const response = await this.fetchFn(targetUri, {
          method,
          headers,
          body: serializedBody,
          signal,
        });
        if (response.status === 404) return undefined;
        if (!response.ok) {
          let parsed: unknown;
          try {
            parsed = await response.json();
          } catch {
            parsed = undefined;
          }
          const code =
            parsed &&
            typeof parsed === "object" &&
            typeof (parsed as { code?: unknown }).code === "string"
              ? (parsed as { code: string }).code
              : `LEGACY_HTTP_${response.status}`;
          throw new LegacyHttpError(response.status, code, parsed);
        }
        return response.json();
      },
      {
        timeoutMs,
        breaker: this.breaker,
        retry: this.retryPolicy,
      },
    );
  }
  async lookup(id: string, opts?: LegacyCallOptions) {
    return this.call(
      `/v1/requests/${id}`,
      "GET",
      undefined,
      false,
      opts,
      this.timeouts.lookup,
    );
  }
  async submit(a: Allocation, opts?: LegacyCallOptions) {
    const result = await this.call(
      "/v1/requests",
      "POST",
      {
        reference: a.id,
        sourceAccount: a.sourceAccount,
        targetAccount: a.targetAccount,
        amountMinor: a.amountMinor,
        currency: a.currency,
      },
      false,
      opts,
      this.timeouts.submit,
    );
    if (!result) throw new LegacyInvariantError("LEGACY_SUBMIT_NOT_FOUND");
    return result;
  }
  async inquire(id: string, opts?: LegacyCallOptions) {
    return this.call(
      `/v1/requests/${id}/inquiry`,
      "POST",
      {},
      true,
      opts,
      this.timeouts.inquire,
    );
  }
  async retryUnposted(id: string, opts?: LegacyCallOptions) {
    return this.call(
      `/v1/requests/${id}/retry`,
      "POST",
      {},
      true,
      opts,
      this.timeouts.retry,
    );
  }
  async accounts(opts?: LegacyCallOptions): Promise<AccountSnapshot> {
    const data = await this.call(
      "/v1/accounts",
      "GET",
      undefined,
      false,
      opts,
      this.timeouts.accounts,
    );
    if (
      !data ||
      typeof data.generation !== "string" ||
      !Number.isFinite(Date.parse(data.observedAt)) ||
      !Number.isSafeInteger(data.sequence) ||
      data.sequence < 0 ||
      !Array.isArray(data.balances) ||
      data.balances.length > 100 ||
      data.balances.some(
        (a: any) =>
          !/^[A-Z0-9]{12}$/.test(a.account) ||
          !Number.isSafeInteger(a.amountMinor) ||
          a.amountMinor < 0 ||
          a.amountMinor > 999999999999 ||
          a.currency !== "ZAR" ||
          !["CLIENT", "EMPLOYEE", "SETTLEMENT"].includes(a.kind) ||
          !["ACTIVE", "SUSPENDED"].includes(a.state),
      ) ||
      new Set(data.balances.map((a: any) => a.account)).size !==
        data.balances.length
    )
      throw new LegacyInvariantError("LEGACY_INVALID_ACCOUNT_SNAPSHOT");
    return data;
  }
  async inventory(opts?: LegacyCallOptions): Promise<LegacyInventory> {
    const data = await this.call(
      "/v1/reconciliation",
      "GET",
      undefined,
      false,
      opts,
      this.timeouts.inventory,
    );
    const validRows = (rows: any) =>
      Array.isArray(rows) &&
      rows.length <= 5000 &&
      rows.every(
        (r: any) =>
          typeof r.reference === "string" &&
          UUID.test(r.reference) &&
          typeof r.sourceAccount === "string" &&
          typeof r.targetAccount === "string" &&
          Number.isSafeInteger(r.amountMinor) &&
          typeof r.currency === "string" &&
          typeof r.status === "string" &&
          (r.postingId === null ||
            (typeof r.postingId === "string" && UUID.test(r.postingId))),
      );
    if (
      !data ||
      !validRows(data.requests) ||
      !validRows(data.core?.records) ||
      typeof data.core.generation !== "string" ||
      !Number.isFinite(Date.parse(data.core.observedAt)) ||
      !Array.isArray(data.batches) ||
      !Array.isArray(data.core.balances) ||
      data.batches.length > 5000 ||
      typeof data.truncated !== "boolean" ||
      data.batches.some(
        (b: any) =>
          typeof b.id !== "string" ||
          !UUID.test(b.id) ||
          typeof b.control_match !== "boolean",
      )
    )
      throw new LegacyInvariantError("LEGACY_INVALID_RECONCILIATION");
    return data;
  }
}
