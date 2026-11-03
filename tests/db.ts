// Helpers for database tests. Import `prisma` from here so the test DB guard in setup.ts has already run.
import { prisma } from "../lib/db";

export { prisma };

/** Wipe every table. TRUNCATE ... CASCADE follows foreign keys, so order doesn't matter. */
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AuditEvent", "Draft", "ActionItem", "Analysis", "Thread", "SlackUser", "Workspace" CASCADE`,
  );
}

/**
 * The smallest graph a Draft needs: workspace -> user -> thread -> analysis -> draft.
 * Returns ids you'll need in transition tests. Status defaults to SUGGESTED.
 */
export async function createDraftFixture(opts: { status?: "SUGGESTED" | "APPROVED" | "REJECTED" | "POSTING" | "POSTED" | "FAILED" } = {}) {
  const workspace = await prisma.workspace.create({ data: { slackTeamId: "T_TEST", name: "Test" } });
  const user = await prisma.slackUser.create({
    data: { workspaceId: workspace.id, slackUserId: "U_TEST", displayName: "Tester" },
  });
  const thread = await prisma.thread.create({
    data: { workspaceId: workspace.id, channelId: "C_TEST", threadTs: "1700000000.000001" },
  });
  const analysis = await prisma.analysis.create({
    data: { threadId: thread.id, requestedById: user.id, throughTs: "1700000001.000001", status: "DONE" },
  });
  const draft = await prisma.draft.create({
    data: { analysisId: analysis.id, type: "REPLY", text: "hello", status: opts.status ?? "SUGGESTED" },
  });
  return { workspaceId: workspace.id, userId: user.id, threadId: thread.id, analysisId: analysis.id, draftId: draft.id };
}
