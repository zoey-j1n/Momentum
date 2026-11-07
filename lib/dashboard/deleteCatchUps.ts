// Delete the signed-in person's analyses of one thread, with their
// drafts and items, so the thread leaves their list. Other people's catch-ups of the same thread stay
// (decision #19: an analysis is one person's). Refused while one of theirs is still PENDING or RUNNING,
// because a worker may be about to write to it. Posted Slack messages are not touched: they are history.
import { prisma } from "../db";
import type { Viewer } from "./access";

export class DeleteError extends Error {}

export async function deleteMyCatchUps(threadId: string, v: Viewer): Promise<{ analyses: number }> {
  return prisma.$transaction(async (tx) => {
    const mine = await tx.analysis.findMany({ where: { threadId, requestedById: v.userId, thread: { workspaceId: v.workspaceId } }, select: { id: true, status: true } });
    if (mine.length === 0) throw new DeleteError("nothing of yours on this thread");
    if (mine.some((a) => a.status === "PENDING" || a.status === "RUNNING")) throw new DeleteError("an analysis is still running; try again in a minute");
    const ids = mine.map((a) => a.id);
    await tx.draft.deleteMany({ where: { analysisId: { in: ids } } });
    await tx.actionItem.deleteMany({ where: { analysisId: { in: ids } } });
    await tx.analysis.deleteMany({ where: { id: { in: ids } } });
    await tx.auditEvent.create({ data: { workspaceId: v.workspaceId, actorId: v.userId, entityType: "Thread", entityId: threadId, action: "delete_catchups", fromStatus: String(ids.length), toStatus: "0" } });
    return { analyses: ids.length };
  });
}
