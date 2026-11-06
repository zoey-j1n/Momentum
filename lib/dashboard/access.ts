// Who may see and act on what (decision #9, visibility option b): a thread is yours if you ran the shortcut
// on it at least once. The same rule answers both questions, "which threads do I list" and "may I touch
// this draft", so the list and the buttons can never disagree.
//
// Why it matters: the bot can read private channels it was added to, so a workspace-wide dashboard would
// show a private channel's summary to people who are not in it. Requester-only closes that.
// Later upgrade (option c, channel membership): change threadVisibleTo() only; every caller stays the same.
import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../db";

export type Viewer = { workspaceId: string; userId: string };

/** Prisma `where` fragment for Thread: in this workspace, and this person requested an analysis on it. */
export function threadVisibleTo(v: Viewer): Prisma.ThreadWhereInput {
  return { workspaceId: v.workspaceId, analyses: { some: { requestedById: v.userId } } };
}

export class AccessError extends Error {}

/** Throws unless the draft is on a thread the viewer can see. Call before any action on a draft. */
export async function assertDraftAccess(draftId: string, v: Viewer): Promise<void> {
  const n = await prisma.draft.count({ where: { id: draftId, analysis: { thread: threadVisibleTo(v) } } });
  if (n === 0) throw new AccessError("draft not found, or not on a thread you requested");
}

export async function assertActionItemAccess(actionItemId: string, v: Viewer): Promise<void> {
  const n = await prisma.actionItem.count({ where: { id: actionItemId, analysis: { thread: threadVisibleTo(v) } } });
  if (n === 0) throw new AccessError("action item not found, or not on a thread you requested");
}
