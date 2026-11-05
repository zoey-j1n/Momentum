// Milestone 4 done-when: kill the worker mid-job, restart it, and see exactly one analysis with no duplicate drafts.
// This script does the killing so the timing is not up to human reflexes. Costs one Haiku call.
//   npx tsx scripts/crash-test.ts
// Stop any other `npm run worker` first, or it will take the job before this script's worker does.
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { prisma } from "../lib/db";
import { enqueueSample } from "./lib/sample";

const PAUSE_MS = 15_000; // the fake reader sleeps this long, which is the window we kill in

// One real process (node --import tsx), so SIGKILL kills the worker itself and not just a wrapper.
function startWorker(label: string, env: Record<string, string>): { child: ChildProcess; waitFor: (needle: string) => Promise<void> } {
  const child = spawn(process.execPath, ["--import", "tsx", "worker/index.ts"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const lines: string[] = [];
  const waiters: { needle: string; resolve: () => void }[] = [];
  child.stdout!.on("data", (buf: Buffer) => {
    for (const line of buf.toString().split("\n").filter(Boolean)) {
      console.log(`  [${label}] ${line}`);
      lines.push(line);
      for (const w of [...waiters]) if (line.includes(w.needle)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
    }
  });
  const waitFor = (needle: string) =>
    new Promise<void>((resolve, reject) => {
      if (lines.some((l) => l.includes(needle))) return resolve();
      waiters.push({ needle, resolve });
      setTimeout(() => reject(new Error(`timed out waiting for "${needle}" from ${label}`)), 90_000).unref();
    });
  return { child, waitFor };
}

async function snapshot(jobId: string, analysisId: string) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, attempts: true, lockedBy: true } });
  const analysis = await prisma.analysis.findUniqueOrThrow({
    where: { id: analysisId },
    select: { status: true, attempts: true, throughTs: true, thread: { select: { lastAnalyzedTs: true } }, _count: { select: { drafts: true, actionItems: true } } },
  });
  return { job, analysis: { status: analysis.status, attempts: analysis.attempts, throughTs: analysis.throughTs, drafts: analysis._count.drafts, items: analysis._count.actionItems, cursor: analysis.thread.lastAnalyzedTs } };
}

function check(cond: boolean, what: string, failures: string[]) {
  console.log(`  ${cond ? "ok " : "BAD"} ${what}`);
  if (!cond) failures.push(what);
}

async function main() {
  const failures: string[] = [];
  const { analysisId, jobId } = await enqueueSample();
  console.log(`1. enqueued analysis ${analysisId}, job ${jobId}`);

  // Worker A claims the job, then sleeps inside the fake Slack read. We kill it there.
  const a = startWorker("A", { SLACK_USE_FAKE_READER: "1", CRASH_TEST_PAUSE_MS: String(PAUSE_MS) });
  await a.waitFor("attempt 1/3 start");
  await new Promise((r) => setTimeout(r, 1_000)); // let step 1 (RUNNING) land
  a.child.kill("SIGKILL");
  console.log("2. killed worker A mid-job");

  const mid = await snapshot(jobId, analysisId);
  console.log("   state after crash:", JSON.stringify(mid));
  check(mid.job.status === "RUNNING" && mid.job.attempts === 1, "job is RUNNING with attempts 1", failures);
  check(mid.analysis.status === "RUNNING" && mid.analysis.drafts === 0, "analysis is RUNNING with no drafts (nothing partial was written)", failures);

  // Worker B must NOT take it while the lease is fresh.
  const b = startWorker("B", { SLACK_USE_FAKE_READER: "1" });
  await new Promise((r) => setTimeout(r, 2_500));
  const held = await snapshot(jobId, analysisId);
  check(held.job.attempts === 1, "fresh lease: worker B left the job alone", failures);

  // Expire the lease by hand (the DB clock), as if 5 minutes had passed.
  await prisma.$executeRaw`UPDATE "Job" SET "lockedAt" = now() - interval '10 minutes' WHERE id = ${jobId}`;
  console.log("3. expired the lease; worker B should reclaim");

  await b.waitFor("attempt 2/3 start");
  await b.waitFor(`job ${jobId} DONE`);
  b.child.kill("SIGTERM");

  const end = await snapshot(jobId, analysisId);
  console.log("4. final state:", JSON.stringify(end));
  check(end.job.status === "DONE" && end.job.attempts === 2, "job DONE after exactly 2 attempts", failures);
  check(end.analysis.status === "DONE" && end.analysis.attempts === 2, "analysis DONE, attempts 2", failures);
  check(end.analysis.drafts === 4, "exactly 4 drafts (no duplicates)", failures);
  check(end.analysis.cursor !== null && end.analysis.cursor === end.analysis.throughTs, "thread cursor advanced and equals analysis.throughTs", failures);
  check((await prisma.analysis.count({ where: { threadId: (await prisma.analysis.findUniqueOrThrow({ where: { id: analysisId } })).threadId } })) === 1, "exactly one analysis for the thread", failures);

  console.log(failures.length === 0 ? "\nCRASH TEST PASSED" : `\nCRASH TEST FAILED: ${failures.join("; ")}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    setTimeout(() => process.exit(), 500).unref();
  });
