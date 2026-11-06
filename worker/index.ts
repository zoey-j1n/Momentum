// The always-on worker: `npm run worker`. Calls runJobs forever with a short sleep when the queue is empty.
// Ctrl-C finishes the job in progress, then exits. Kill -9 does not, which is the crash test.
import "dotenv/config";
import os from "node:os";
import { runJobs } from "../lib/jobs/queue";
import { defaultHandlers, usingFakeReader } from "../lib/jobs/handlers";
import { reconcileStuckDrafts } from "../lib/drafts/reconcile";
// Production has no loop: app/api/jobs/run calls lib/jobs/runOnce.ts once per request instead (decision #9).

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1_000);
const BATCH = 10;
const RECONCILE_MS = Number(process.env.RECONCILE_MS ?? 60_000); // how often to look for drafts stuck in POSTING
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
  console.log(`[worker ${workerId}] started, polling every ${POLL_MS}ms, slack reader: ${usingFakeReader ? "FAKE (sample thread)" : "real"}`);
  let lastReconcile = 0;
  while (!stopping) {
    const n = await runJobs(BATCH, { workerId, handlers: defaultHandlers, log: (l) => console.log(`[worker] ${l}`) });
    if (Date.now() - lastReconcile >= RECONCILE_MS) {
      lastReconcile = Date.now();
      if (!usingFakeReader) {
        try {
          await reconcileStuckDrafts({ log: (l) => console.log(`[reconciler] ${l}`) });
        } catch (e) {
          console.error("[reconciler]", e);
        }
      }
    }
    if (n === 0) await sleep(POLL_MS);
  }
  console.log(`[worker ${workerId}] stopped`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
