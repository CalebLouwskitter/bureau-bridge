import { UUID, type Allocation, type AccountSnapshot } from "@bureau/contracts";
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
export class LegacyClient implements Legacy {
  constructor(
    private base: string,
    private bridgeKey: string,
    private opsKey?: string,
  ) {}
  private async call(
    path: string,
    method = "GET",
    body?: unknown,
    ops = false,
    opts?: LegacyCallOptions,
  ) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ops ? this.opsKey : this.bridgeKey}`,
      "Content-Type": "application/json",
    };
    if (opts?.fencingToken !== undefined) {
      headers["X-Fencing-Token"] = String(opts.fencingToken);
    }
    const response = await fetch(this.base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`LEGACY_HTTP_${response.status}`);
    return response.json();
  }
  async lookup(id: string, opts?: LegacyCallOptions) {
    return this.call(`/v1/requests/${id}`, "GET", undefined, false, opts);
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
    );
    if (!result) throw new Error("LEGACY_SUBMIT_NOT_FOUND");
    return result;
  }
  async inquire(id: string, opts?: LegacyCallOptions) {
    return this.call(`/v1/requests/${id}/inquiry`, "POST", {}, true, opts);
  }
  async retryUnposted(id: string, opts?: LegacyCallOptions) {
    return this.call(`/v1/requests/${id}/retry`, "POST", {}, true, opts);
  }
  async accounts(opts?: LegacyCallOptions): Promise<AccountSnapshot> {
    const data = await this.call("/v1/accounts", "GET", undefined, false, opts);
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
      throw new Error("LEGACY_INVALID_ACCOUNT_SNAPSHOT");
    return data;
  }
  async inventory(opts?: LegacyCallOptions): Promise<LegacyInventory> {
    const data = await this.call(
      "/v1/reconciliation",
      "GET",
      undefined,
      false,
      opts,
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
      throw new Error("LEGACY_INVALID_RECONCILIATION");
    return data;
  }
}
