// Job "notion_export": create the Notion meeting page for an INVITE draft (decision #18, amended 2026-11-07).
// Two triggers: the "Create Notion page" button while the invite is still a draft (v1's behaviour: the page
// link is appended to the draft text so it goes out with the message), and automatically after an invite
// is posted without one.
//
// Idempotent in two layers. Before creating, look for a page with the same title (a retry after a crash
// between "page created" and "URL recorded" reuses it). After creating, record the URL with a conditional
// update, so a second worker that somehow got here records nothing and the first URL stands.
import { prisma } from "../db";
import { NonRetryableError } from "../jobs/errors";
import type { NotionClient } from "../notion";

export function meetingTitle(summary: string | null): string {
  return "Meeting — " + (summary ?? "").slice(0, 60);
}

export async function exportInviteToNotion(draftId: string, notion: NotionClient): Promise<"created" | "reused" | "skipped"> {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: { type: true, status: true, text: true, notionPageUrl: true, analysis: { select: { summary: true, requestedBy: { select: { displayName: true } } } } },
  });
  if (!draft) throw new NonRetryableError(`draft ${draftId} not found`);
  if (draft.type !== "INVITE" || draft.status === "REJECTED") throw new NonRetryableError(`draft ${draftId} is ${draft.type}/${draft.status}, not an invite to export`);
  if (draft.notionPageUrl) return "skipped"; // already exported (a redelivered or retried job)

  const title = meetingTitle(draft.analysis.summary);
  let url = await notion.findMeetingPage(title); // network, outside any transaction
  let outcome: "created" | "reused" = "reused";
  if (!url) {
    url = await notion.createMeetingPage({ title, notes: draft.text, requestedBy: draft.analysis.requestedBy.displayName });
    outcome = "created";
  }

  const { count } = await prisma.draft.updateMany({ where: { id: draftId, notionPageUrl: null }, data: { notionPageUrl: url } });
  // Still a draft: put the link into the message, as v1 did. Approved or posted text is never edited.
  if (count === 1) await prisma.draft.updateMany({ where: { id: draftId, status: "SUGGESTED" }, data: { text: `${draft.text}\n\nNotion page: ${url}` } });
  return count === 1 ? outcome : "skipped";
}
