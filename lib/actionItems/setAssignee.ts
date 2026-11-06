// The reviewer confirms or changes an action item's owner (Milestone 6).
// One conditional update scoped by workspace, plus an audit event, in one transaction. The chosen
// assignee must belong to the same workspace, or the update matches zero rows and we throw.
import { prisma } from "../db";

export class AssignError extends Error {}

export async function setAssignee(actionItemId: string, workspaceId: string, actorId: string, assigneeId: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (assigneeId !== null) {
      const ok = await tx.slackUser.count({ where: { id: assigneeId, workspaceId } });
      if (ok !== 1) throw new AssignError("that person is not in this workspace");
    }
    const before = await tx.actionItem.findFirst({ where: { id: actionItemId, analysis: { thread: { workspaceId } } }, select: { assigneeId: true } });
    if (!before) throw new AssignError("action item not found in this workspace");
    const { count } = await tx.actionItem.updateMany({
      where: { id: actionItemId, analysis: { thread: { workspaceId } } },
      data: { assigneeId, assignmentSource: "MANUAL", assigneeConfirmed: true },
    });
    if (count !== 1) throw new AssignError("action item not found in this workspace");
    await tx.auditEvent.create({
      data: { workspaceId, actorId, entityType: "ActionItem", entityId: actionItemId, action: "assign", fromStatus: before.assigneeId ?? "none", toStatus: assigneeId ?? "none" },
    });
  });
}
