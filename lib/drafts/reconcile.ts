// The reconciler (Milestone 6, decision #16). A draft stuck in POSTING means the process stopped between
// "post to Slack" and "record the result". We cannot know which side of the post it died on, so we look.
//
// For each draft POSTING for longer than STUCK_AFTER_MS: read the thread's replies since just before the
// claim, and find ours by
//   1. the hidden metadata { momentum_draft, draft_id }  (present when Slack accepted it), else
//   2. the same approver, the same text, posted after the claim.
// Found  -> POSTED with that ts. Not found -> FAILED ("not found in thread"), which the reviewer can retry.
// Both writes go through transitions.ts and are conditional on status still being POSTING.
import { prisma } from "../db";
import { markFailed, markPosted, TransitionError } from "./transitions";
import { SlackRepliesReader, type RepliesReader } from "../slack/findPosted";

export const STUCK_AFTER_MS = 2 * 60_000;

export type ReconcileOutcome = { draftId: string; result: "posted" | "failed" | "skipped" };

export async function reconcileStuckDrafts(opts: { reader?: RepliesReader; stuckAfterMs?: number; now?: Date; log?: (l: string) => void } = {}): Promise<ReconcileOutcome[]> {
  const reader = opts.reader ?? new SlackRepliesReader();
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.stuckAfterMs ?? STUCK_AFTER_MS));
  const log = opts.log ?? (() => {});

  const stuck = await prisma.draft.findMany({
    where: { status: "POSTING", updatedAt: { lt: cutoff } },
    select: {
      id: true, text: true, updatedAt: true,
      approvedBy: { select: { slackUserId: true } },
      analysis: { select: { thread: { select: { workspaceId: true, channelId: true, threadTs: true } } } },
    },
  });

  const outcomes: ReconcileOutcome[] = [];
  for (const d of stuck) {
    const thread = d.analysis.thread;
    // updatedAt is the claim time (the last status change). Look from one minute before it, as a Slack ts string.
    const sinceTs = `${Math.floor(d.updatedAt.getTime() / 1000) - 60}.000000`;
    let replies;
    try {
      replies = await reader.repliesSince(thread.channelId, thread.threadTs, sinceTs);
    } catch (err) {
      log(`draft ${d.id}: could not read thread (${err instanceof Error ? err.message : err}); will try again next round`);
      outcomes.push({ draftId: d.id, result: "skipped" });
      continue;
    }
    const byMetadata = replies.find((r) => r.draftId === d.id);
    const byContent = replies.find((r) => r.user !== null && r.user === d.approvedBy?.slackUserId && normalize(r.text) === normalize(d.text));
    const found = byMetadata ?? byContent;
    try {
      if (found) {
        await markPosted(d.id, thread.workspaceId, found.ts);
        log(`draft ${d.id}: found in thread (${byMetadata ? "metadata" : "content match"}) at ${found.ts}, POSTED`);
        outcomes.push({ draftId: d.id, result: "posted" });
      } else {
        await markFailed(d.id, thread.workspaceId, "not found in thread after timeout; safe to retry");
        log(`draft ${d.id}: not in thread, FAILED`);
        outcomes.push({ draftId: d.id, result: "failed" });
      }
    } catch (err) {
      if (err instanceof TransitionError) { outcomes.push({ draftId: d.id, result: "skipped" }); continue; } // someone settled it meanwhile
      throw err;
    }
  }
  return outcomes;
}

// Slack stores text with &, <, > escaped and may trim; compare what we can.
function normalize(t: string): string {
  return t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
