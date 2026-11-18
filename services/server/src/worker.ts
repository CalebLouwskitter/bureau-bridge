import type { Status } from "@bureau/contracts";
import type { Store } from "./store.ts";
import type { Legacy } from "./legacy.ts";
import {
  CircuitOpenError,
  isTransientError,
  LegacyHttpError,
  LegacyInvariantError,
} from "./resilience.ts";

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

export async function tick(store: Store, legacy: Legacy): Promise<boolean> {
  const job = await store.claim();
  if (!job) return false;
  try {
    const allocation = await store.get(job.id);
    if (!allocation) throw new LegacyInvariantError("MISSING_ALLOCATION");
    if (["POSTED", "DECLINED"].includes(allocation.status)) {
      await store.finish(job, allocation);
      return true;
    }
    // Always inspect the stable reference before submitting. A retry preserves it.
    const callOpts = { fencingToken: job.fencingToken };
    const result =
      (await legacy.lookup(job.id, callOpts)) ??
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
    await store.finish(job, {
      status,
      reason: result.reason,
      postingId: result.postingId,
    });
  } catch (error) {
    if (error instanceof LegacyHttpError && error.code === "STALE_FENCING_TOKEN") {
      return true;
    }
    const reason = classifyReason(error);
    if (!isTransientError(error)) {
      if (store.deadLetter) {
        await store.deadLetter(job, reason);
      } else {
        await store.finish(job, {
          status: "NEEDS_REVIEW",
          reason,
          postingId: null,
        });
      }
      return true;
    }
    await store.retry(job, reason);
  }
  return true;
}
