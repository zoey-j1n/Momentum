// Shared by enqueue-sample.ts and crash-test.ts: one PENDING analysis of the sample thread plus its job.
import { prisma } from "../../lib/db";
import { enqueue } from "../../lib/jobs/queue";
import { SAMPLE_THREAD } from "../../lib/slack/readThread";

export async function enqueueSample(): Promise<{ analysisId: string; jobId: string; threadId: string }> {
  const ws = await prisma.workspace.upsert({
    where: { slackTeamId: "T0SEED" },
    update: {},
    create: { slackTeamId: "T0SEED", name: "Seed Workspace" },
  });
  const requester = await prisma.slackUser.upsert({
    where: { workspaceId_slackUserId: { workspaceId: ws.id, slackUserId: "U0ZOEY" } },
    update: {},
    create: { workspaceId: ws.id, slackUserId: "U0ZOEY", displayName: "Zoey" },
  });
  const thread = await prisma.thread.upsert({
    where: { workspaceId_channelId_threadTs: { workspaceId: ws.id, channelId: "C0SAMPLE", threadTs: SAMPLE_THREAD[0].ts } },
    update: { lastAnalyzedTs: null }, // reset the cursor so the fake reader returns the whole thread again
    create: { workspaceId: ws.id, channelId: "C0SAMPLE", threadTs: SAMPLE_THREAD[0].ts },
  });

  const throughTs = SAMPLE_THREAD[SAMPLE_THREAD.length - 1].ts;

  // Reset: wipe any previous run's results so the unique (threadId, throughTs) does not block us.
  const previous = await prisma.analysis.findUnique({ where: { threadId_throughTs: { threadId: thread.id, throughTs } } });
  if (previous) {
    await prisma.$transaction([
      prisma.draft.deleteMany({ where: { analysisId: previous.id } }),
      prisma.actionItem.deleteMany({ where: { analysisId: previous.id } }),
      prisma.analysis.delete({ where: { id: previous.id } }),
    ]);
  }

  const analysis = await prisma.analysis.create({
    data: { threadId: thread.id, requestedById: requester.id, throughTs, status: "PENDING" },
  });
  const jobId = await enqueue("analyze", { analysisId: analysis.id });
  return { analysisId: analysis.id, jobId, threadId: thread.id };
}
