// Job "notion_export": after an INVITE draft is posted, create its meeting page in Notion (decision #18).
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
  if (draft.type !== "INVITE" || draft.status !== "POSTED") throw new NonRetryableError(`draft ${draftId} is ${draft.type}/${draft.status}, not a posted invite`);
  if (draft.notionPageUrl) return "skipped"; // already exported (a redelivered or retried job)

  const title = meetingTitle(draft.analysis.summary);
  let url = await notion.findMeetingPage(title); // network, outside any transaction
  let outcome: "created" | "reused" = "reused";
  if (!url) {
    url = await notion.createMeetingPage({ title, notes: draft.text, requestedBy: draft.analysis.requestedBy.displayName });
    outcome = "created";
  }

  const { count } = await prisma.draft.updateMany({ where: { id: draftId, notionPageUrl: null }, data: { notionPageUrl: url } });
  return count === 1 ? outcome : "skipped";
}
