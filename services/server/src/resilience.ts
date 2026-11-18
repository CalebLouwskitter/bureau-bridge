export const NON_TRANSIENT_DOMAIN_ERRORS = new Set([
  "LEGACY_RESPONSE_MISMATCH",
  "INVALID_LEGACY_STATUS",
  "LEGACY_INVALID_ACCOUNT_SNAPSHOT",
  "LEGACY_INVALID_RECONCILIATION",
  "LEGACY_SUBMIT_NOT_FOUND",
  "MISSING_ALLOCATION",
]);

export class LegacyHttpError extends Error {
  readonly transient: boolean;
  constructor(
    readonly status: number,
    readonly code = `LEGACY_HTTP_${status}`,
    readonly body?: unknown,
  ) {
    super(`LEGACY_HTTP_${status}`);
    this.name = "LegacyHttpError";
    this.transient =
      status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
}

export class LegacyInvariantError extends Error {
  readonly transient = false;
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "LegacyInvariantError";
  }
}

export class CircuitOpenError extends Error {
  readonly code = "LEGACY_CIRCUIT_OPEN";
  readonly transient = true;
  constructor(readonly retryAfterMs: number) {
    super("LEGACY_CIRCUIT_OPEN");
    this.name = "CircuitOpenError";
  }
}

export function isTransientError(error: unknown): boolean {
  if (error instanceof LegacyHttpError) return error.transient;
  if (error instanceof LegacyInvariantError) return false;
  if (error instanceof CircuitOpenError) return true;
  if (error instanceof Error) {
    if (NON_TRANSIENT_DOMAIN_ERRORS.has(error.message)) return false;
    // Standard fetch network/timeout errors and unexpected transport failures.
    if (
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      error.name === "TypeError"
    ) {
      return true;
    }
  }
  return true;
}

export function isRetryableWithinPolicy(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return false;
  return isTransientError(error);
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  halfOpenAfterMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly halfOpenAfterMs: number;
  private readonly now: () => number;

  private currentState: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.halfOpenAfterMs = options.halfOpenAfterMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  get state(): CircuitState {
    if (
      this.currentState === "OPEN" &&
      this.now() - this.openedAt >= this.halfOpenAfterMs
    ) {
      return "HALF_OPEN";
    }
    return this.currentState;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = this.now();
    if (this.currentState === "OPEN") {
      const elapsed = now - this.openedAt;
      if (elapsed < this.halfOpenAfterMs) {
        throw new CircuitOpenError(this.halfOpenAfterMs - elapsed);
      }
      this.currentState = "HALF_OPEN";
      this.probeInFlight = false;
    }

    if (this.currentState === "HALF_OPEN") {
      if (this.probeInFlight) {
        throw new CircuitOpenError(this.halfOpenAfterMs);
      }
      this.probeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.currentState = "CLOSED";
    this.probeInFlight = false;
  }

  private onFailure(error: unknown): void {
    // Non-transient 4xx or domain invariant errors mean the downstream
    // service responded; do not trip or keep open the outage breaker.
    if (!isTransientError(error) || error instanceof CircuitOpenError) {
      if (this.currentState === "HALF_OPEN") {
        this.currentState = "CLOSED";
        this.consecutiveFailures = 0;
        this.probeInFlight = false;
      }
      return;
    }

    if (this.currentState === "HALF_OPEN") {
      this.currentState = "OPEN";
      this.openedAt = this.now();
      this.probeInFlight = false;
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.currentState = "OPEN";
      this.openedAt = this.now();
    }
  }
}

export interface RetryBudgetOptions {
  windowMs?: number;
  maxRetryRatio?: number;
  minRetriesPerWindow?: number;
  maxRetriesPerWindow?: number;
  now?: () => number;
}

export class RetryBudget {
  private readonly windowMs: number;
  private readonly maxRetryRatio: number;
  private readonly minRetriesPerWindow: number;
  private readonly maxRetriesPerWindow: number;
  private readonly now: () => number;
  private readonly requestTimestamps: number[] = [];
  private readonly retryTimestamps: number[] = [];

  constructor(options: RetryBudgetOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRetryRatio = options.maxRetryRatio ?? 0.2;
    this.minRetriesPerWindow = options.minRetriesPerWindow ?? 10;
    this.maxRetriesPerWindow = options.maxRetriesPerWindow ?? 50;
    this.now = options.now ?? (() => Date.now());
  }

  private prune(current: number): void {
    const cutoff = current - this.windowMs;
    while (this.requestTimestamps.length && this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps.shift();
    }
    while (this.retryTimestamps.length && this.retryTimestamps[0] < cutoff) {
      this.retryTimestamps.shift();
    }
  }

  recordRequest(): void {
    const current = this.now();
    this.prune(current);
    this.requestTimestamps.push(current);
  }

  tryConsumeRetry(): boolean {
    const current = this.now();
    this.prune(current);
    const allowed = Math.min(
      this.maxRetriesPerWindow,
      Math.max(
        this.minRetriesPerWindow,
        Math.floor(this.requestTimestamps.length * this.maxRetryRatio),
      ),
    );
    if (this.retryTimestamps.length >= allowed) {
      return false;
    }
    this.retryTimestamps.push(current);
    return true;
  }

  get recentRetries(): number {
    this.prune(this.now());
    return this.retryTimestamps.length;
  }
}

/**
 * AWS-style decorrelated jitter backoff:
 *   sleep = min(capMs, random_between(baseMs, prevSleepMs * 3))
 */
export function decorrelatedJitterDelay(
  prevSleepMs: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const high = Math.max(baseMs, prevSleepMs * 3);
  const raw = baseMs + random() * (high - baseMs);
  return Math.min(capMs, Math.max(baseMs, Math.round(raw)));
}

export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  budget?: RetryBudget;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function executeResilient<T>(
  fn: (signal: AbortSignal, attempt: number) => Promise<T>,
  options: {
    timeoutMs: number;
    breaker: CircuitBreaker;
    retry?: RetryPolicyOptions;
  },
): Promise<T> {
  const maxAttempts = options.retry?.maxAttempts ?? 3;
  const baseDelayMs = options.retry?.baseDelayMs ?? 150;
  const maxDelayMs = options.retry?.maxDelayMs ?? 2_000;
  const budget = options.retry?.budget;
  const random = options.retry?.random ?? Math.random;
  const sleep = options.retry?.sleep ?? defaultSleep;

  budget?.recordRequest();
  let prevSleep = baseDelayMs;

  for (let attempt = 1; ; attempt++) {
    try {
      return await options.breaker.execute(() => {
        const signal = AbortSignal.timeout(options.timeoutMs);
        return fn(signal, attempt);
      });
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableWithinPolicy(error)) {
        throw error;
      }
      if (budget && !budget.tryConsumeRetry()) {
        throw error;
      }
      const delay = decorrelatedJitterDelay(
        prevSleep,
        baseDelayMs,
        maxDelayMs,
        random,
      );
      prevSleep = delay;
      await sleep(delay);
    }
  }
}
