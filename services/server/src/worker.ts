import type { Status } from "@bureau/contracts";
import type { Store } from "./store.ts";
import type { Legacy } from "./legacy.ts";
import {
  CircuitOpenError,
  isTransientError,
  LegacyHttpError,
  LegacyInvariantError,
} from "./resilience.ts";
import {
  createChildTraceparent,
  extractOrCreateTraceparent,
} from "./trace.ts";

export type WorkerLogger = (entry: Record<string, unknown>) => void;

const mapping: Record<string, Status> = {
  RECEIVED: "AWAITING_BATCH",
  BATCHED: "PROCESSING",
  VERIFYING: "VERIFYING",
  POSTED: "POSTED",
  DECLINED: "DECLINED",
};

function classifyReason(error: unknown): string {
  if (error instanceof LegacyInvariantError) return error.code;
  if (error instanceof LegacyHttpError) return error.message;
  if (error instanceof CircuitOpenError) return error.code;
  if (
    error instanceof Error &&
    (error.message.startsWith("LEGACY_") ||
      error.message === "INVALID_LEGACY_STATUS" ||
      error.message === "MISSING_ALLOCATION")
  ) {
    return error.message;
  }
  return "DELIVERY_OR_VERIFICATION_FAILED";
}

export async function tick(
  store: Store,
  legacy: Legacy,
  log?: WorkerLogger,
): Promise<boolean> {
  const job = await store.claim();
  if (!job) return false;
  let trace = extractOrCreateTraceparent(job.traceparent);
  try {
    const allocation = await store.get(job.id);
    if (!allocation) throw new LegacyInvariantError("MISSING_ALLOCATION");
    if (!job.traceparent && allocation.traceparent) {
      trace = extractOrCreateTraceparent(allocation.traceparent);
    }
    const tracedJob = { ...job, traceparent: trace.raw };
    if (["POSTED", "DECLINED"].includes(allocation.status)) {
      await store.finish(tracedJob, allocation);
      return true;
    }
    // Always inspect the stable reference before submitting. A retry preserves it.
    const child = createChildTraceparent(trace);
    const callOpts = {
      fencingToken: tracedJob.fencingToken,
      traceparent: child.raw,
    };
    const result =
      (await legacy.lookup(tracedJob.id, callOpts)) ??
      (await legacy.submit(allocation, callOpts));
    if (
      result.reference !== allocation.id ||
      result.sourceAccount !== allocation.sourceAccount ||
      result.targetAccount !== allocation.targetAccount ||
      result.amountMinor !== allocation.amountMinor ||
      result.currency !== allocation.currency
    )
      throw new LegacyInvariantError("LEGACY_RESPONSE_MISMATCH");
    const status = mapping[result.status];
    if (
      !status ||
      (status === "POSTED" && result.postingId !== allocation.id) ||
      (status === "DECLINED" && result.postingId !== null)
    )
      throw new LegacyInvariantError("INVALID_LEGACY_STATUS");
    await store.finish(tracedJob, {
      status,
      reason: result.reason,
      postingId: result.postingId,
    });
    log?.({
      level: "info",
      component: "worker",
      event: "allocation_transitioned",
      allocationId: tracedJob.id,
      fencingToken: tracedJob.fencingToken,
      status,
      traceId: trace.traceId,
      traceparent: child.raw,
    });
  } catch (error) {
    if (error instanceof LegacyHttpError && error.code === "STALE_FENCING_TOKEN") {
      log?.({
        level: "warn",
        component: "worker",
        event: "stale_fencing_token_rejected",
        allocationId: job.id,
        fencingToken: job.fencingToken,
        traceId: trace.traceId,
        traceparent: trace.raw,
      });
      return true;
    }
    const reason = classifyReason(error);
    const tracedJob = { ...job, traceparent: trace.raw };
    if (!isTransientError(error)) {
      log?.({
        level: "error",
        component: "worker",
        event: "allocation_dead_lettered",
        allocationId: job.id,
        fencingToken: job.fencingToken,
        reason,
        traceId: trace.traceId,
        traceparent: trace.raw,
      });
      if (store.deadLetter) {
        await store.deadLetter(tracedJob, reason);
      } else {
        await store.finish(tracedJob, {
          status: "NEEDS_REVIEW",
          reason,
          postingId: null,
        });
      }
      return true;
    }
    log?.({
      level: "warn",
      component: "worker",
      event: "allocation_retry_scheduled",
      allocationId: job.id,
      fencingToken: job.fencingToken,
      reason,
      traceId: trace.traceId,
      traceparent: trace.raw,
    });
    await store.retry(tracedJob, reason);
  }
  return true;
}
