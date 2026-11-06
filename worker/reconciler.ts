// The reconciler as its own process: `npx tsx worker/reconciler.ts`. The worker also runs it every
// minute (worker/index.ts), so this entry point is for running it by hand or on a schedule.
import "dotenv/config";
import { reconcileStuckDrafts } from "../lib/drafts/reconcile";
import { prisma } from "../lib/db";

reconcileStuckDrafts({ log: (l) => console.log(`[reconciler] ${l}`) })
  .then((o) => console.log(`[reconciler] checked ${o.length} stuck draft(s)`))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
