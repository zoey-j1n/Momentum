/**
 * Decision #5. Turns the model's `owner` string into a SlackUser id, or nothing. Pure: arrays in, object out, no DB.
 * How the arrays are loaded is the caller's concern; the schema's @@index([workspaceId, displayName]) is the
 * scaling path (query only matching names instead of passing every user).
 *
 * Rules, in order, stop at the first that applies:
 *  1. owner is a participant's Slack ID (spoke, mentioned, requester, or channel member) -> THREAD_ID,
 *     UNLESS someone else in the thread shares that user's first name. Then the model resolved an ambiguity
 *     on its own, which the eval showed it gets wrong (decision #22: the two-Alexes thread, wrong Alex in
 *     6 of 6 runs), so the match is downgraded to NONE with both people as candidates ("pick one").
 *  2. owner is a name and exactly one PARTICIPANT has that name      -> THREAD_NAME (the thread breaks the tie;
 *     people in the thread outrank people who are only in the channel)
 *  3. exactly one WORKSPACE user has that name                        -> NAME_MATCH
 *  4. otherwise                                                        -> NONE
 * A name matches a display name exactly or as its first word ("Alex" matches "Alex Chen"), case-insensitive.
 * Every result carries `candidates`: all workspace users whose name matched, for the dashboard's picker.
 * A surviving match is unambiguous by construction (an ID with no same-first-name participant, or exactly one
 * name match), so the Next steps post may mention it. The other way an owner becomes a mention is a reviewer's
 * pick (assigneeConfirmed). Nothing ambiguous is ever stored as an assignee (decision #21, amended 2026-11-11).
 */

import type { Participant } from "./transcript";

export type WorkspaceUser = { id: string; slackUserId: string; displayName: string }; // id is SlackUser.id in our DB
export type Match = {
  assigneeId: string | null;
  source: "THREAD_ID" | "THREAD_NAME" | "NAME_MATCH" | "NONE";
  candidates: WorkspaceUser[];
};

const normalize = (s: string) => s.trim().toLowerCase().replace(/^@/, "");

// "Alex" matches "Alex" and "Alex Chen"; "Alex Chen" matches only "Alex Chen". `name` must already be normalized.
export function nameMatches(name: string, displayName: string): boolean {
  const d = normalize(displayName);
  return name !== "" && (d === name || d.split(/\s+/)[0] === name);
}

/** The dashboard's view of the same rule: which workspace users does the model's raw owner string match? */
export function ownerCandidates<U extends { displayName: string; slackUserId?: string }>(owner: string, users: U[]): U[] {
  const { id, name } = splitOwner(owner);
  // A bare ID (the model's owner for a downgraded rule-1 match) has no name to match on: use that user's first name.
  const byId = users.find((u) => u.slackUserId !== undefined && u.slackUserId === id);
  const key = byId && name === normalize(id) ? firstName(byId.displayName) : name;
  return users.filter((u) => nameMatches(key, u.displayName));
}

const firstName = (displayName: string): string => normalize(displayName).split(/\s+/)[0] ?? "";

/** "Team", "nobody", "" and the like: the model's way of saying unassigned, not a failed match. */
export function isUnassignedOwner(owner: string): boolean {
  return ["", "team", "nobody", "none", "unassigned", "n/a", "tbd"].includes(normalize(owner));
}

// The model sometimes echoes the prose format "Alex (U123ABC)". Split it into the two parts the rules need.
function splitOwner(owner: string): { id: string; name: string } {
  const m = owner.match(/^(.*?)\s*\(([UW][A-Z0-9]+)\)\s*$/);
  if (m) return { id: m[2], name: normalize(m[1]) };
  return { id: owner.trim(), name: normalize(owner) };
}

export function matchAssignee(owner: string, participants: Participant[], workspaceUsers: WorkspaceUser[]): Match {
  const { id, name } = splitOwner(owner);
  const bySlackId = (slackUserId: string) => workspaceUsers.find((u) => u.slackUserId === slackUserId);

  // Computed once; attached to every result so the dashboard can always offer the name matches.
  const candidates = workspaceUsers.filter((u) => nameMatches(name, u.displayName));

  // 1. owner is a participant's Slack ID. Accepted only when nobody else in the thread (spoke, mentioned,
  //    requester; channel members don't count, or every "Alex" would be ambiguous) shares the first name.
  if (participants.some((p) => p.slackUserId === id)) {
    const user = bySlackId(id);
    if (user) {
      const first = firstName(user.displayName);
      const sameFirstName = participants.filter((p) => p.slackUserId !== id && p.role !== "channel" && firstName(p.displayName) === first);
      if (first !== "" && sameFirstName.length > 0) {
        const ids = new Set([id, ...sameFirstName.map((p) => p.slackUserId)]);
        return { assigneeId: null, source: "NONE", candidates: workspaceUsers.filter((u) => ids.has(u.slackUserId)) };
      }
      return { assigneeId: user.id, source: "THREAD_ID", candidates };
    }
  }

  // 2. owner is a name, and exactly one participant has it: the thread settles which person.
  //    People who spoke, were mentioned, or asked for the catch-up outrank channel members who did neither
  //    (decision #10 addendum): "Alex" in a thread with one Alex is that Alex, even if the channel has three.
  const inThread = participants.filter((p) => p.role !== "channel" && nameMatches(name, p.displayName));
  const inChannel = participants.filter((p) => p.role === "channel" && nameMatches(name, p.displayName));
  const participantMatches = inThread.length > 0 ? inThread : inChannel;
  if (participantMatches.length === 1) {
    const user = bySlackId(participantMatches[0].slackUserId);
    if (user) return { assigneeId: user.id, source: "THREAD_NAME", candidates };
  }

  // 3. exactly one workspace user has that name
  if (candidates.length === 1) {
    return { assigneeId: candidates[0].id, source: "NAME_MATCH", candidates };
  }

  // 4. no single match ("Team", unknown ID, two Alexes, empty): the picker gets whatever matched
  return { assigneeId: null, source: "NONE", candidates };
}
