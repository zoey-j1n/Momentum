// Creates (or resets) one PENDING analysis of the sample thread and queues an "analyze" job for it.
// Then run `npm run worker` and watch it. Re-run this script to reset and go again.
//   npx tsx scripts/enqueue-sample.ts
import "dotenv/config";
import { prisma } from "../lib/db";
import { enqueueSample } from "./lib/sample";

enqueueSample()
  .then(({ analysisId, jobId }) => console.log(`analysis ${analysisId} PENDING, job ${jobId} QUEUED. Now: npm run worker`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
