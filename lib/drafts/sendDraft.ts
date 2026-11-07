// Approve & send (Milestone 6). DESIGN.md 4.5 and decision #7: record intent before the side effect.
//
//   edit (if the reviewer changed the text)  SUGGESTED -> SUGGESTED
//   approve                                   SUGGESTED -> APPROVED
//   claim                                     APPROVED | FAILED -> POSTING      (false = someone else is sending: stop)
//   load the approver's token                 no token -> FAILED ("sign in again"), decision #9
//   post to Slack                             the only network call, outside every transaction
//     Slack answered "no"   -> FAILED  (markFailed; safe to retry)
//     Slack answered "yes"  -> POSTED  (markPosted with the message ts)
//     no usable answer      -> leave POSTING; the reconciler settles it (lib/drafts/reconcile.ts)
//
// Every status change goes through transitions.ts; this file never touches Draft.status itself.
import { ErrorCode, type WebAPICallError } from "@slack/web-api";
import { prisma } from "../db";
import { approveDraft, claimDraft, editDraft, markFailed, markPosted, TransitionError } from "./transitions";
import { postDraftToThread, type PostDraftInput, type PostDraftResult } from "../slack/postMessage";
import { decryptToken, TokenCryptoError } from "../crypto/tokens";

// The dev-only flag for the timeout test. Loud when on, refused in production, so it cannot linger unnoticed.
const failAfterPost = () => process.env.SEND_DRAFT_FAIL_AFTER_POST === "1"; // read per call so tests can toggle it
if (failAfterPost()) {
  if (process.env.NODE_ENV === "production") throw new Error("SEND_DRAFT_FAIL_AFTER_POST is set in production; refusing to start");
  console.warn("\n!!! SEND_DRAFT_FAIL_AFTER_POST=1: every Approve & send will post to Slack and then pretend it timed out. Dev test only. !!!\n");
}

export type SendDraftResult =
  | { outcome: "posted"; ts: string }
  | { outcome: "failed"; reason: string }
  | { outcome: "unknown" } // POSTING: Slack may or may not have the message
  | { outcome: "busy" }; // another request is already sending it

export type SendDeps = { post: (input: PostDraftInput) => Promise<PostDraftResult> };

export async function sendDraft(
  draftId: string,
  workspaceId: string,
  actorId: string,
  text: string,
  deps: SendDeps = { post: postDraftToThread },
): Promise<SendDraftResult> {
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, analysis: { thread: { workspaceId } } },
    select: { status: true, text: true, type: true, analysis: { select: { thread: { select: { channelId: true, threadTs: true } } } } },
  });
  if (!draft) throw new Error(`draft ${draftId} not found in workspace`);

  // 1. Approval covers the exact text the reviewer saw. Save their edit first, then approve.
  if (draft.status === "SUGGESTED") {
    try {
      if (text !== draft.text) await editDraft(draftId, workspaceId, actorId, text);
      await approveDraft(draftId, workspaceId, actorId);
    } catch (err) {
      // Lost a race: someone approved (or rejected) it between our read and our write. Fall through to the
      // claim, which decides on the real current status.
      if (!(err instanceof TransitionError)) throw err;
    }
  }

  // 2. The gate. One statement; the second of two simultaneous clicks changes zero rows and stops here.
  const claimed = await claimDraft(draftId, workspaceId, actorId);
  if (!claimed) return { outcome: "busy" };

  // 3. The approver's own token (decision #15). Missing or unreadable: fail the draft with a reason the
  //    dashboard shows; Retry works after they sign in again. Checked after the claim so the outcome is
  //    recorded on the row, not just in this response.
  //    Exception (decision #21): NEXT_STEPS is posted by the Momentum bot, so no personal token is needed.
  let userToken: string | undefined;
  if (draft.type !== "NEXT_STEPS") {
    const approver = await prisma.slackUser.findFirst({ where: { id: actorId, workspaceId }, select: { userTokenEnc: true } });
    try {
      if (!approver?.userTokenEnc) throw new TokenCryptoError("no Slack token stored for you");
      userToken = decryptToken(approver.userTokenEnc);
    } catch (err) {
      const reason = `${err instanceof Error ? err.message : String(err)}; sign in again to post`;
      await markFailed(draftId, workspaceId, reason);
      return { outcome: "failed", reason };
    }
  }

  // 4. The side effect. Re-read the text: claim happened after our edit, so this is the approved text.
  const approved = await prisma.draft.findUniqueOrThrow({ where: { id: draftId }, select: { text: true } });
  let posted: PostDraftResult;
  try {
    posted = await deps.post({ channelId: draft.analysis.thread.channelId, threadTs: draft.analysis.thread.threadTs, text: approved.text, draftId, userToken });
    // Done-when "timeout test": the message is in Slack, but we die before recording it.
    if (failAfterPost()) throw Object.assign(new Error("simulated timeout after post"), { code: ErrorCode.RequestError });
  } catch (err) {
    const kind = classify(err);
    if (kind === "slack_said_no") {
      const reason = slackReason(err);
      await markFailed(draftId, workspaceId, reason);
      return { outcome: "failed", reason };
    }
    // Timeout, connection reset, 5xx: we do not know whether the message exists. Leave POSTING.
    console.warn(`[sendDraft] draft ${draftId} left POSTING: ${err instanceof Error ? err.message : String(err)}`);
    return { outcome: "unknown" };
  }

  // 5. Record the result. If THIS write fails (process dies), the reconciler finds the message by its ts/metadata.
  await markPosted(draftId, workspaceId, posted.ts);
  return { outcome: "posted", ts: posted.ts };
}

// "Slack said no" = Slack received the request and rejected it, so nothing was posted. Anything else is unknown.
function classify(err: unknown): "slack_said_no" | "unknown" {
  const e = err as Partial<WebAPICallError> & { code?: string };
  if (e?.code === ErrorCode.PlatformError || e?.code === ErrorCode.RateLimitedError) return "slack_said_no";
  return "unknown";
}

// Slack errors that mean the approver's token is no longer good: say so, because the fix is theirs to make.
const TOKEN_ERRORS = new Set(["token_revoked", "token_expired", "invalid_auth", "account_inactive", "not_authed"]);

function slackReason(err: unknown): string {
  const e = err as { code?: string; data?: { error?: string }; retryAfter?: number; message?: string };
  if (e?.code === ErrorCode.PlatformError) {
    const code = e.data?.error ?? "slack error";
    return TOKEN_ERRORS.has(code) ? `${code}; sign in again to post` : code;
  }
  if (e?.code === ErrorCode.RateLimitedError) return `rate limited, retry after ${e.retryAfter ?? "?"}s`;
  return e?.message ?? String(err);
}
