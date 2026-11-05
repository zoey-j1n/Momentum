// The always-on worker: `npm run worker`. Calls runJobs forever with a short sleep when the queue is empty.
// Ctrl-C finishes the job in progress, then exits. Kill -9 does not, which is the crash test.
import "dotenv/config";
import os from "node:os";
import { runJobs } from "../lib/jobs/queue";
import { defaultHandlers } from "../lib/jobs/handlers";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1_000);
const BATCH = 10;
const workerId = `${os.hostname()}-${process.pid}`;

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker ${workerId}] ${sig}: finishing current job, then exiting`);
    stopping = true;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`[worker ${workerId}] started, polling every ${POLL_MS}ms`);
  while (!stopping) {
    const n = await runJobs(BATCH, { workerId, handlers: defaultHandlers, log: (l) => console.log(`[worker] ${l}`) });
    if (n === 0) await sleep(POLL_MS);
  }
  console.log(`[worker ${workerId}] stopped`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
