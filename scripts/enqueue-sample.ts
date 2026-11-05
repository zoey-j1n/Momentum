// Creates (or resets) one PENDING analysis of the sample thread and queues an "analyze" job for it.
// Then run `SLACK_USE_FAKE_READER=1 npm run worker` and watch it (the sample thread is not a real Slack thread). Re-run this script to reset and go again.
//   npx tsx scripts/enqueue-sample.ts
import "dotenv/config";
import { prisma } from "../lib/db";
import { enqueueSample } from "./lib/sample";

enqueueSample()
  .then(({ analysisId, jobId }) => console.log(`analysis ${analysisId} PENDING, job ${jobId} QUEUED. Now: SLACK_USE_FAKE_READER=1 npm run worker`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
