// Wake the production job runner (decision #9) right after something was queued, so the work starts now
// rather than at the next cron tick. No-op locally, where `npm run worker` is polling: JOBS_RUN_SECRET is
// only set in production. Fire-and-forget; a failed kick is logged and the cron safety net covers it.
export async function kickRunner(origin?: string): Promise<void> {
  const secret = process.env.JOBS_RUN_SECRET;
  if (!secret) return;
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? origin;
  if (!base) return;
  try {
    const res = await fetch(`${base}/api/jobs/run`, { method: "POST", headers: { "x-jobs-secret": secret } });
    if (!res.ok) console.warn(`[jobs] runner kick failed: ${res.status}`);
  } catch (e) {
    console.warn(`[jobs] runner kick failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
