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

  // Reset: wipe any previous run's results. The partial unique index (one PENDING/RUNNING analysis per
  // thread) and the unique (threadId, throughTs) would both block a re-run otherwise.
  const previous = await prisma.analysis.findMany({ where: { threadId: thread.id }, select: { id: true } });
  if (previous.length > 0) {
    const ids = previous.map((a) => a.id);
    await prisma.$transaction([
      prisma.draft.deleteMany({ where: { analysisId: { in: ids } } }),
      prisma.actionItem.deleteMany({ where: { analysisId: { in: ids } } }),
      prisma.analysis.deleteMany({ where: { id: { in: ids } } }),
    ]);
  }

  // throughTs stays null here; the worker fills it in when it commits (decision #14).
  const analysis = await prisma.analysis.create({
    data: { threadId: thread.id, requestedById: requester.id, status: "PENDING" },
  });
  const jobId = await enqueue("analyze", { analysisId: analysis.id });
  return { analysisId: analysis.id, jobId, threadId: thread.id };
}
