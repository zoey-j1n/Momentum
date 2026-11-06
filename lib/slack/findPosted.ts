// What the reconciler needs from Slack: the replies in a thread since a point, with who posted,
// the text, and our hidden metadata if Slack kept it. Interface + real reader + fake for tests.
import { slackClient } from "./client";
import { DRAFT_METADATA_EVENT } from "./postMessage";

export type PostedReply = { ts: string; user: string | null; text: string; draftId: string | null };

export interface RepliesReader {
  /** Replies with ts > afterTs, newest last. afterTs is a Slack ts string; compared as strings. */
  repliesSince(channelId: string, threadTs: string, afterTs: string): Promise<PostedReply[]>;
}

type RawReply = { ts?: string; user?: string; text?: string; metadata?: { event_type?: string; event_payload?: { draft_id?: unknown } } };

export class SlackRepliesReader implements RepliesReader {
  async repliesSince(channelId: string, threadTs: string, afterTs: string): Promise<PostedReply[]> {
    const out: PostedReply[] = [];
    let cursor: string | undefined;
    do {
      const page = await slackClient().conversations.replies({ channel: channelId, ts: threadTs, oldest: afterTs, inclusive: false, limit: 200, cursor, include_all_metadata: true });
      for (const m of (page.messages ?? []) as RawReply[]) {
        if (!m.ts || m.ts <= afterTs) continue;
        const md = m.metadata;
        const draftId = md?.event_type === DRAFT_METADATA_EVENT && typeof md.event_payload?.draft_id === "string" ? md.event_payload.draft_id : null;
        out.push({ ts: m.ts, user: m.user ?? null, text: m.text ?? "", draftId });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }
}

export class FakeRepliesReader implements RepliesReader {
  constructor(public replies: PostedReply[] = []) {}
  async repliesSince(_c: string, _t: string, afterTs: string) {
    return this.replies.filter((r) => r.ts > afterTs);
  }
}
