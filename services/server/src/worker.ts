import type { Status } from "@bureau/contracts";
import type { Store } from "./store.ts";
import type { Legacy } from "./legacy.ts";
const mapping: Record<string, Status> = {
  RECEIVED: "AWAITING_BATCH",
  BATCHED: "PROCESSING",
  VERIFYING: "VERIFYING",
  POSTED: "POSTED",
  DECLINED: "DECLINED",
};
export async function tick(store: Store, legacy: Legacy): Promise<boolean> {
  const job = await store.claim();
  if (!job) return false;
  try {
    const allocation = await store.get(job.id);
    if (!allocation) throw new Error("MISSING_ALLOCATION");
    if (["POSTED", "DECLINED"].includes(allocation.status)) {
      await store.finish(job, allocation);
      return true;
    }
    // Always inspect the stable reference before submitting. A retry preserves it.
    const result =
      (await legacy.lookup(job.id)) ?? (await legacy.submit(allocation));
    if (
      result.reference !== allocation.id ||
      result.sourceAccount !== allocation.sourceAccount ||
      result.targetAccount !== allocation.targetAccount ||
      result.amountMinor !== allocation.amountMinor ||
      result.currency !== allocation.currency
    )
      throw new Error("LEGACY_RESPONSE_MISMATCH");
    const status = mapping[result.status];
    if (
      !status ||
      (status === "POSTED" && result.postingId !== allocation.id) ||
      (status === "DECLINED" && result.postingId !== null)
    )
      throw new Error("INVALID_LEGACY_STATUS");
    await store.finish(job, {
      status,
      reason: result.reason,
      postingId: result.postingId,
    });
  } catch (error) {
    await store.retry(
      job,
      error instanceof Error && error.message.startsWith("LEGACY_")
        ? error.message
        : "DELIVERY_OR_VERIFICATION_FAILED",
    );
  }
  return true;
}
