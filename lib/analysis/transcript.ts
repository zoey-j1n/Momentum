// Turns Slack messages into the text Claude reads. Pure: no Slack, no database.
// Rule: Slack user IDs survive next to names ("Khoa (U02ABC): ..."), so the model can name owners by ID
// and the matcher can check them (DESIGN decisions #5 and #10).

export type SlackMessage = { user: string; text: string; ts: string };

// role: how this person relates to the thread. spoke = wrote a message; mentioned = @-mentioned but silent;
// requester = asked for this catch-up; channel = in the channel but none of the above (decision #10 addendum).
export type ParticipantRole = "spoke" | "mentioned" | "requester" | "channel";
export type Participant = { slackUserId: string; displayName: string; role?: ParticipantRole };

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** Every user id @-mentioned in these messages, in first-seen order. */
export function mentionedUserIds(messages: { text: string }[]): string[] {
  const seen = new Set<string>();
  for (const m of messages) for (const match of m.text.matchAll(MENTION_RE)) seen.add(match[1]);
  return [...seen];
}

/**
 * Add people to a participant list without duplicates. Earlier roles win: someone who spoke stays "spoke"
 * even if they are also mentioned, the requester, or in the channel.
 */
export function addParticipants(list: Participant[], people: Participant[]): Participant[] {
  const out = [...list];
  const have = new Set(out.map((p) => p.slackUserId));
  for (const p of people) if (!have.has(p.slackUserId)) { out.push(p); have.add(p.slackUserId); }
  return out;
}

export type TranscriptResult = {
  transcript: string; // oldest first, most recent messages that fit under the cap
  participants: Participant[]; // everyone who spoke or was mentioned in the whole thread, first-seen order
  droppedMessages: number; // how many old messages the cap cut off (for the metrics row and the prompt)
};

export const DEFAULT_TRANSCRIPT_CHARS = 12_000;

export function buildTranscript(
  messages: SlackMessage[],
  displayNames: Map<string, string>,
  maxChars: number = DEFAULT_TRANSCRIPT_CHARS,
): TranscriptResult {
  // 1. one place that decides how a user is shown
  const formatUser = (id: string) => `${displayNames.get(id) ?? "unknown"} (${id})`;

  // 2. swap <@U123> or <@U123|label> for "name (U123)"
  const resolveMentions = (text: string) => text.replace(MENTION_RE, (_match, id: string) => formatUser(id));

  // 3. oldest first. Slack ts is a fixed-width string ("1730700000.000200"), so string order is time order.
  //    Never Number() it: a float can lose the last digits (decision #2).
  const sorted = [...messages].sort((a, b) => a.ts.localeCompare(b.ts));

  // 4. participants come from the WHOLE thread, not just the lines we keep. The matcher needs every real
  //    participant ID so that an owner mentioned early in a long thread still resolves.
  const seen = new Map<string, Participant>();
  for (const msg of sorted) {
    if (!seen.has(msg.user)) seen.set(msg.user, { slackUserId: msg.user, displayName: displayNames.get(msg.user) ?? "unknown", role: "spoke" });
  }
  // People who were @-mentioned but never wrote: valid owners too ("<@U_ZOEY> can you book it?").
  for (const id of mentionedUserIds(sorted)) {
    if (!seen.has(id)) seen.set(id, { slackUserId: id, displayName: displayNames.get(id) ?? "unknown", role: "mentioned" });
  }

  // 5. build all lines, then keep the most recent ones that fit under the cap (DESIGN 4.9: per-request caps).
  const lines = sorted.map((msg) => `${formatUser(msg.user)}: ${resolveMentions(msg.text)}`);
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1; // +1 for the newline
    if (total + cost > maxChars && kept.length > 0) break; // always keep at least the newest message
    kept.unshift(lines[i]);
    total += cost;
  }

  return {
    transcript: kept.join("\n"),
    participants: [...seen.values()],
    droppedMessages: lines.length - kept.length,
  };
}
