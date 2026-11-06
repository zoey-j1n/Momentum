// One pass of background work: a batch of jobs, then a reconcile sweep. The HTTP endpoint (decision #9)
// calls it once per request. The local worker loop (worker/index.ts) does the same two steps forever.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { runJobs } from "./queue";
import { defaultHandlers, usingFakeReader } from "./handlers";
import { reconcileStuckDrafts } from "../drafts/reconcile";

export type RunOnceResult = { workerId: string; jobs: number; reconciled: number; ms: number };

export async function runOnce(opts: { workerId?: string; batch?: number; log?: (l: string) => void } = {}): Promise<RunOnceResult> {
  const started = Date.now();
  const workerId = opts.workerId ?? `run-${randomUUID().slice(0, 8)}`;
  const log = opts.log ?? (() => {});
  const jobs = await runJobs(opts.batch ?? 10, { workerId, handlers: defaultHandlers, log: (l) => log(`[worker] ${l}`) });
  let reconciled = 0;
  if (!usingFakeReader) {
    try {
      reconciled = (await reconcileStuckDrafts({ log: (l) => log(`[reconciler] ${l}`) })).length;
    } catch (e) {
      log(`[reconciler] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { workerId, jobs, reconciled, ms: Date.now() - started };
}

/** Constant-time check of the runner secret. Same shape as the Slack signature compare. */
export function runnerSecretOk(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
