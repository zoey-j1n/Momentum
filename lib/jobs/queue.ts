/**
 * The hand-rolled queue (decision #8). Four operations on the Job table plus the loop that uses them.
 *
 *   enqueue      -> insert a QUEUED row
 *   claimNext    -> ONE statement that finds a runnable job, locks it, and marks it RUNNING for this worker
 *   complete     -> RUNNING -> DONE
 *   retryOrFail  -> RUNNING -> QUEUED with a later runAt (backoff + jitter), or FAILED
 *   runJobs      -> claim, dispatch by type, record the outcome; repeat up to `limit` times
 *
 * The queue knows nothing about analyses. A handler is just `(payload) => Promise<void>`; it signals
 * "do not retry" by throwing NonRetryableError. Everything else that throws is retried.
 */
import { prisma } from "../db";
import type { Prisma } from "@/generated/prisma/client";
import { NonRetryableError } from "./errors";

export type Handler = (payload: unknown) => Promise<void>;
export type Handlers = Record<string, Handler>;

export const LEASE_MS = 5 * 60_000; // decision #8 sub-decision: fixed lease, no heartbeat
export const BACKOFF_BASE_MS = Number(process.env.JOB_BACKOFF_BASE_MS ?? 1_000);
export const BACKOFF_MAX_MS = 5 * 60_000;

// What claimNext returns. Raw SQL gives us the row with its real column names.
export type ClaimedJob = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
};

export async function enqueue(
  type: string,
  payload: Prisma.InputJsonValue,
  opts: { runAt?: Date; maxAttempts?: number } = {},
): Promise<string> {
  const job = await prisma.job.create({
    data: { type, payload, runAt: opts.runAt, maxAttempts: opts.maxAttempts },
    select: { id: true },
  });
  return job.id;
}

/**
 * The claim. One UPDATE whose target row comes from a locking subselect:
 *
 *   SELECT ... WHERE runnable ORDER BY "runAt" LIMIT 1 FOR UPDATE SKIP LOCKED
 *
 * "runnable" is QUEUED with runAt in the past, OR RUNNING with a lockedAt older than the lease
 * (the holder is presumed dead; this is the reclaim). FOR UPDATE locks the chosen row until this
 * statement commits; SKIP LOCKED makes a second worker skip that row instead of waiting for it.
 * So N workers running this at the same instant get N different jobs, or null.
 *
 * Why one statement and not SELECT then UPDATE: a statement is atomic. Between a separate SELECT
 * and UPDATE another worker could claim the same id. (Compare claimDraft in transitions.ts, which
 * uses a conditional updateMany for the same reason.)
 */
export async function claimNext(workerId: string, leaseMs: number = LEASE_MS): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "Job"
    SET status = 'RUNNING',
        "lockedAt" = now(),
        "lockedBy" = ${workerId},
        attempts = attempts + 1,
        "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "Job"
      WHERE (status = 'QUEUED' AND "runAt" <= now())
         OR (status = 'RUNNING' AND "lockedAt" < now() - (${leaseMs} || ' milliseconds')::interval)
      ORDER BY "runAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, payload, attempts, "maxAttempts"
  `;
  return rows[0] ?? null;
}

/** RUNNING -> DONE. Guarded by lockedBy: a worker whose lease expired must not finish a job someone else now holds. */
export async function complete(jobId: string, workerId: string): Promise<boolean> {
  const { count } = await prisma.job.updateMany({
    where: { id: jobId, status: "RUNNING", lockedBy: workerId },
    data: { status: "DONE", lockedAt: null, lockedBy: null },
  });
  return count === 1;
}

/** Exponential backoff with full jitter: random in [0, min(cap, base * 2^(attempt-1))]. */
export function backoffMs(attempt: number, base = BACKOFF_BASE_MS, cap = BACKOFF_MAX_MS): number {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

/**
 * The handler threw. Retry later, or give up.
 *   give up when: NonRetryableError, or attempts >= maxAttempts (the poison cap)
 *   otherwise:    back to QUEUED with runAt pushed forward by backoff + jitter
 * Same lockedBy guard as complete().
 */
export async function retryOrFail(job: ClaimedJob, workerId: string, err: unknown): Promise<"retry" | "failed" | "lost"> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const giveUp = err instanceof NonRetryableError || job.attempts >= job.maxAttempts;

  let count: number;
  if (giveUp) {
    ({ count } = await prisma.job.updateMany({
      where: { id: job.id, status: "RUNNING", lockedBy: workerId },
      data: { status: "FAILED", lastError: message, lockedAt: null, lockedBy: null },
    }));
  } else {
    // One clock rule: runAt is computed from the database's now(), the same clock the claim compares against.
    // A client-side Date here could be ahead of or behind the DB by enough to make a job claimable too early or late.
    const delaySecs = backoffMs(job.attempts) / 1000;
    count = await prisma.$executeRaw`
      UPDATE "Job"
      SET status = 'QUEUED', "lastError" = ${message}, "lockedAt" = NULL, "lockedBy" = NULL,
          "runAt" = now() + make_interval(secs => ${delaySecs}), "updatedAt" = now()
      WHERE id = ${job.id} AND status = 'RUNNING' AND "lockedBy" = ${workerId}
    `;
  }
  if (count === 0) return "lost"; // lease expired and someone else holds it now; they will record their own outcome
  return giveUp ? "failed" : "retry";
}

/**
 * Process up to `limit` jobs and return how many were claimed. This is the whole worker loop body.
 * worker/index.ts calls it forever; a cron-hit HTTP endpoint (decision #9) calls it once.
 */
export async function runJobs(
  limit: number,
  opts: { workerId: string; handlers: Handlers; leaseMs?: number; log?: (line: string) => void },
): Promise<number> {
  const log = opts.log ?? (() => {});
  let processed = 0;

  for (let i = 0; i < limit; i++) {
    const job = await claimNext(opts.workerId, opts.leaseMs);
    if (!job) break;
    processed++;

    const handler = opts.handlers[job.type];
    if (!handler) {
      // A job type nobody handles will never succeed; do not burn retries on it.
      await retryOrFail(job, opts.workerId, new NonRetryableError(`no handler for job type "${job.type}"`));
      log(`job ${job.id} type=${job.type} FAILED: no handler`);
      continue;
    }

    log(`job ${job.id} type=${job.type} attempt ${job.attempts}/${job.maxAttempts} start`);
    try {
      await handler(job.payload);
      const ok = await complete(job.id, opts.workerId);
      log(`job ${job.id} ${ok ? "DONE" : "finished but lease was lost"}`);
    } catch (err) {
      const outcome = await retryOrFail(job, opts.workerId, err);
      log(`job ${job.id} ${outcome}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return processed;
}
