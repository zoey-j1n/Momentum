// Fake data for local development. Every write is an upsert on a unique key, so running
// `npx prisma db seed` twice leaves exactly one of everything (DESIGN.md decision #1, #3).
import "dotenv/config";
import { prisma } from "../lib/db";

async function main() {
  const ws = await prisma.workspace.upsert({
    where: { slackTeamId: "T0SEED" },
    update: {},
    create: { slackTeamId: "T0SEED", name: "Seed Workspace" },
  });

  // Two Alexes on purpose: the owner matcher (decision #5) must refuse to guess between them.
  const people = [
    { slackUserId: "U0KHOA", displayName: "Khoa", realName: "Khoa Nguyen" },
    { slackUserId: "U0ZOEY", displayName: "Zoey", realName: "Zoey Jin" },
    { slackUserId: "U0ALEX1", displayName: "Alex", realName: "Alex Chen" },
    { slackUserId: "U0ALEX2", displayName: "Alex", realName: "Alex Rivera" },
  ];
  const users: Record<string, { id: string }> = {};
  for (const p of people) {
    users[p.slackUserId] = await prisma.slackUser.upsert({
      where: { workspaceId_slackUserId: { workspaceId: ws.id, slackUserId: p.slackUserId } },
      update: { displayName: p.displayName, realName: p.realName },
      create: { workspaceId: ws.id, ...p },
    });
  }

  const thread = await prisma.thread.upsert({
    where: {
      workspaceId_channelId_threadTs: {
        workspaceId: ws.id,
        channelId: "C0SEED",
        threadTs: "1729650000.123456",
      },
    },
    update: {},
    create: { workspaceId: ws.id, channelId: "C0SEED", threadTs: "1729650000.123456" },
  });

  // Nested create: the analysis, its action items, and its drafts are written in one transaction.
  // The upsert key (threadId, throughTs) is what makes a second seed run a no-op.
  await prisma.analysis.upsert({
    where: { threadId_throughTs: { threadId: thread.id, throughTs: "1729650999.000100" } },
    update: {},
    create: {
      threadId: thread.id,
      requestedById: users["U0ZOEY"].id,
      throughTs: "1729650999.000100",
      status: "DONE",
      summary: "The team agreed to ship the dashboard Friday after Khoa finishes design review.",
      decision: "Ship Friday.",
      nextStep: "Khoa completes design review by Thursday.",
      openQuestions: ["Who books the demo room?"],
      needResponse: true,
      rawOutput: { summary: "seed", note: "placeholder raw model output" },
      model: "seed",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: "0",
      actionItems: {
        create: [
          { task: "Finish design review", assigneeName: "Khoa", assigneeId: users["U0KHOA"].id, assignmentSource: "THREAD_ID" },
          { task: "Book the demo room", assigneeName: "Alex" }, // ambiguous: stays NONE
          { task: "Update the roadmap", assigneeName: "Team" },
        ],
      },
      drafts: {
        create: [
          { type: "REPLY", text: "Sounds good. I'll have the review done Thursday so we can ship Friday." },
          { type: "SUMMARY", text: "Recap: shipping Friday pending design review. Open: who books the demo room?" },
          { type: "MEETING", text: "Worth a 15-minute sync Thursday to confirm we're on track for Friday?" },
          { type: "INVITE", text: "Ship readiness sync, Thu 3pm. Agenda: review status, demo room, blockers. Link: TBD" },
        ],
      },
    },
  });

  const counts = {
    workspaces: await prisma.workspace.count(),
    users: await prisma.slackUser.count(),
    threads: await prisma.thread.count(),
    analyses: await prisma.analysis.count(),
    actionItems: await prisma.actionItem.count(),
    drafts: await prisma.draft.count(),
  };
  console.log("Seeded:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
