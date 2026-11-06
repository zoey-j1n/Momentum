// Posting a draft into its thread. Called by sendDraft (lib/drafts/sendDraft.ts) OUTSIDE any transaction.
//
// Identity (decisions #15, #9): the message is posted with the APPROVER's own user token, decrypted by
// sendDraft from SlackUser.userTokenEnc, so it appears under their name with no app marker. There is no
// bot fallback: a reviewer without a stored token cannot post, and sendDraft fails the draft with "sign in again".
//
// Metadata (decision #7): we attach { event_type: "momentum_draft", event_payload: { draft_id } } so the
// reconciler can find the message if our process dies before recording the ts. Verified 2026-11-05 that
// Slack keeps it on user-token posts; the reconciler still has the author+text fallback (decision #16).
import { WebClient } from "@slack/web-api";

export const DRAFT_METADATA_EVENT = "momentum_draft";

export type PostDraftInput = { channelId: string; threadTs: string; text: string; draftId: string; userToken: string };
export type PostDraftResult = { ts: string; warnings: string[] };

/**
 * One chat.postMessage as the approver. Throws on any Slack error or timeout; the caller decides what the
 * draft's status becomes (markFailed vs leave POSTING). Never call this inside prisma.$transaction.
 */
export async function postDraftToThread(input: PostDraftInput): Promise<PostDraftResult> {
  // A client per call: tokens differ per approver, and no SDK retries, because a retried post could double-post.
  const client = new WebClient(input.userToken, { timeout: 10_000, retryConfig: { retries: 0 } });
  const res = await client.chat.postMessage({
    channel: input.channelId,
    thread_ts: input.threadTs,
    text: input.text,
    metadata: { event_type: DRAFT_METADATA_EVENT, event_payload: { draft_id: input.draftId } },
  });
  if (!res.ts) throw new Error("slack chat.postMessage returned ok without a ts");
  const warnings = res.response_metadata?.warnings ?? [];
  if (warnings.length) console.warn(`[slack post] draft ${input.draftId}: warnings ${warnings.join(", ")}`);
  return { ts: res.ts, warnings };
}
