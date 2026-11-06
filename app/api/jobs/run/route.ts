// The production worker (decision #9). Vercel has no always-on process, so "the worker" is this endpoint:
// each call drains up to one batch of jobs and runs one reconcile pass, then returns. Called by the Slack
// ingress right after a click (so analysis starts within a second) and by cron-job.org every 15 minutes
// (so nothing is missed). Protected by a shared secret header; the public cannot make us spend tokens.
import { NextResponse, type NextRequest } from "next/server";
import { runOnce, runnerSecretOk } from "@/lib/jobs/runOnce";

export const maxDuration = 300; // seconds; Vercel Hobby's cap. One analysis is ~6 s measured.
export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  const expected = process.env.JOBS_RUN_SECRET;
  if (!expected) return new Response("JOBS_RUN_SECRET is not set", { status: 500 });
  if (!runnerSecretOk(req.headers.get("x-jobs-secret"), expected)) return new Response("unauthorized", { status: 401 });
  const result = await runOnce({ log: (l) => console.log(l) });
  console.log(`[jobs/run] ${result.workerId}: ${result.jobs} jobs, ${result.reconciled} reconciled, ${result.ms}ms`);
  return NextResponse.json(result);
}

export const POST = handle;
export const GET = handle; // cron-job.org defaults to GET; the secret header is what matters, not the verb
