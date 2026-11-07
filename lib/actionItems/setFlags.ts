// Include-in-next-steps and done, per item (decision #21). Same shape as setAssignee: a conditional update
// scoped by workspace plus an audit event, in one transaction. The caller re-builds the Next steps draft after.
import { prisma } from "../db";
import { AssignError } from "./setAssignee";

export type ItemFlags = { include?: boolean; done?: boolean };

export async function setItemFlags(actionItemId: string, workspaceId: string, actorId: string, flags: ItemFlags): Promise<void> {
  if (flags.include === undefined && flags.done === undefined) return;
  await prisma.$transaction(async (tx) => {
    const before = await tx.actionItem.findFirst({ where: { id: actionItemId, analysis: { thread: { workspaceId } } }, select: { include: true, done: true } });
    if (!before) throw new AssignError("action item not found in this workspace");
    const { count } = await tx.actionItem.updateMany({ where: { id: actionItemId, analysis: { thread: { workspaceId } } }, data: flags });
    if (count !== 1) throw new AssignError("action item not found in this workspace");
    const action = flags.done !== undefined ? (flags.done ? "done" : "reopen") : flags.include ? "include" : "exclude";
    await tx.auditEvent.create({
      data: { workspaceId, actorId, entityType: "ActionItem", entityId: actionItemId, action, fromStatus: JSON.stringify(before), toStatus: JSON.stringify({ ...before, ...flags }) },
    });
  });
}
