// The Next steps post (decision #21, USER_FLOWS §4): the one draft whose text is built by code, not by the
// model, from the action items. Editing the items IS editing the post. Every MATCHED owner becomes a real
// <@mention>. An unmatched name is plain text; no owner says so.
//
// Lifecycle: created with the analysis (if there are open items), re-built whenever an item changes while
// the draft is still SUGGESTED, frozen once approved (approval covers exact text), posted by the bot.
import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../db";
import { isUnassignedOwner } from "../analysis/matchAssignees";

type Db = Prisma.TransactionClient | typeof prisma;

export type NextStepsItem = {
  task: string;
  include: boolean;
  done: boolean;
  assigneeConfirmed: boolean;
  assigneeName: string;
  assignee: { slackUserId: string; displayName: string } | null;
};

export const NEXT_STEPS_REASON = "Open action items that have not been announced in the thread yet";

/** The message text, or null when there is nothing to announce (no open, included items). */
export function buildNextStepsText(items: NextStepsItem[]): string | null {
  const open = items.filter((i) => i.include && !i.done);
  if (open.length === 0) return null;
  const lines = open.map((i) => {
    if (i.assignee) return `• <@${i.assignee.slackUserId}>: ${i.task}`; // matched (by the model or by a reviewer): a real mention
    if (!isUnassignedOwner(i.assigneeName)) return `• ${i.assigneeName}: ${i.task}`; // a name nobody matched: plain text
    return `• ${i.task} (no owner yet)`;
  });
  return ["Next steps from this thread:", ...lines].join("\n");
}

/**
 * Create or re-build the analysis's NEXT_STEPS draft from its unannounced items. Safe to call from inside
 * the commit transaction (pass tx) or after an item edit (default client). Never touches a draft that has
 * left SUGGESTED: an approved or posted text is final.
 */
export async function refreshNextStepsDraft(analysisId: string, db: Db = prisma): Promise<void> {
  const items = await db.actionItem.findMany({
    where: { analysisId, announcedInDraftId: null },
    select: { task: true, include: true, done: true, assigneeConfirmed: true, assigneeName: true, assignee: { select: { slackUserId: true, displayName: true } } },
  });
  const text = buildNextStepsText(items);
  const existing = await db.draft.findUnique({ where: { analysisId_type: { analysisId, type: "NEXT_STEPS" } }, select: { id: true, status: true } });
  if (!existing) {
    if (text) await db.draft.create({ data: { analysisId, type: "NEXT_STEPS", text, reason: NEXT_STEPS_REASON } });
    return;
  }
  if (existing.status !== "SUGGESTED") return;
  // Nothing left to announce: keep the draft but make that visible rather than deleting history.
  await db.draft.updateMany({ where: { id: existing.id, status: "SUGGESTED" }, data: { text: text ?? "Next steps from this thread: nothing open right now." } });
}

/** After an item edit: find its analysis and re-build. */
export async function refreshNextStepsForItem(actionItemId: string): Promise<void> {
  const item = await prisma.actionItem.findUnique({ where: { id: actionItemId }, select: { analysisId: true } });
  if (item) await refreshNextStepsDraft(item.analysisId);
}
