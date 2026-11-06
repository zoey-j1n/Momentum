// Who may see and act on what (decision #9 option b, decision #19): a thread is listed if you ran the
// shortcut on it; within it you see your own catch-ups; a draft or item is yours if its analysis is. The
// same fragments answer "what do I list" and "may I touch this", so the list and the buttons never disagree.
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

/** Prisma `where` fragment for Analysis: one of the viewer's own catch-ups (decision #19). */
export function analysisOwnedBy(v: Viewer): Prisma.AnalysisWhereInput {
  return { requestedById: v.userId, thread: { workspaceId: v.workspaceId } };
}

/** Throws unless the draft belongs to one of the viewer's own analyses. Call before any action on a draft. */
export async function assertDraftAccess(draftId: string, v: Viewer): Promise<void> {
  const n = await prisma.draft.count({ where: { id: draftId, analysis: analysisOwnedBy(v) } });
  if (n === 0) throw new AccessError("draft not found, or not from one of your catch-ups");
}

export async function assertActionItemAccess(actionItemId: string, v: Viewer): Promise<void> {
  const n = await prisma.actionItem.count({ where: { id: actionItemId, analysis: analysisOwnedBy(v) } });
  if (n === 0) throw new AccessError("action item not found, or not from one of your catch-ups");
}
