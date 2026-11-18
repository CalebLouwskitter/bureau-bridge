import type { ReconciliationRun } from "@bureau/contracts";
import type { Legacy } from "./legacy.ts";
import type { PayoutStore } from "./payouts.ts";
import {
  reconcile,
  summarizeVariances,
  type VarianceSummary,
} from "./reconciliation.ts";
import type { Store } from "./store.ts";
import { generateTraceparent } from "./trace.ts";
import type { WorkerLogger } from "./worker.ts";

export interface PostBatchReconciliationResult {
  ran: boolean;
  trigger?: "post_batch" | "scheduled";
  run?: ReconciliationRun;
  summary?: VarianceSummary;
}

export interface PostBatchReconciliationOptions {
  payoutStore?: PayoutStore;
  intervalMs?: number;
  now?: () => number;
  log?: WorkerLogger;
}

/**
 * Automated post-batch & scheduled three-way reconciliation runner.
 * Triggers immediately whenever a new COBOL core generation is observed
 * (post-batch) or when the periodic reconciliation interval elapses.
 */
export class PostBatchReconciliationRunner {
  private lastGeneration: string | null = null;
  private nextScheduledAt: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly payoutStore?: PayoutStore;
  private readonly log?: WorkerLogger;

  constructor(
    private readonly store: Store,
    private readonly legacy: Legacy,
    private readonly clientId: string,
    options: PostBatchReconciliationOptions = {},
  ) {
    this.payoutStore = options.payoutStore;
    this.intervalMs = options.intervalMs ?? 300_000;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log;
    this.nextScheduledAt = 0;
  }

  async runIfNeeded(
    observedGeneration?: string,
  ): Promise<PostBatchReconciliationResult> {
    const current = this.now();
    const postBatch =
      Boolean(observedGeneration) &&
      this.lastGeneration !== null &&
      observedGeneration !== this.lastGeneration;
    const scheduled = current >= this.nextScheduledAt;

    if (!postBatch && !scheduled) {
      if (observedGeneration && this.lastGeneration === null) {
        this.lastGeneration = observedGeneration;
      }
      return { ran: false };
    }

    const trigger: "post_batch" | "scheduled" = postBatch
      ? "post_batch"
      : "scheduled";
    const trace = generateTraceparent();
    const run = await reconcile(
      this.store,
      this.legacy,
      this.clientId,
      this.payoutStore,
      trace.raw,
    );
    this.lastGeneration = observedGeneration ?? run.generation;
    this.nextScheduledAt = current + this.intervalMs;
    const summary = summarizeVariances(run.findings);

    this.log?.({
      level: summary.clean ? "info" : "warn",
      component: "reconciliation-runner",
      event: "three_way_reconciliation_completed",
      trigger,
      runId: run.id,
      clientId: this.clientId,
      generation: run.generation,
      traceId: trace.traceId,
      traceparent: trace.raw,
      ...summary,
    });

    return { ran: true, trigger, run, summary };
  }
}
