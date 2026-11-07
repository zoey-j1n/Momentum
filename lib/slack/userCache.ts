// Names for Slack user ids without a users.info call per person per analysis (scalability, 2026-11-07).
// Order of preference: our own SlackUser rows refreshed in the last 24 hours; then ONE paged users.list
// when many ids are unknown; then users.info per id only for the few that are left. Slack rate-limits
// users.info at roughly 100 calls a minute, so a 200-person channel must not mean 200 calls.
import type { WebClient } from "@slack/web-api";
import { prisma } from "../db";

export type UserName = { displayName: string; realName?: string };
export const NAME_FRESH_MS = 24 * 60 * 60 * 1000;
const LIST_THRESHOLD = 20; // above this many unknown ids, one users.list is cheaper than N users.info

/** Names we already hold and trust: refreshed within the last day. Keyed by Slack user id. */
export async function freshNamesFromDb(slackUserIds: string[], now = new Date()): Promise<Map<string, UserName>> {
  if (slackUserIds.length === 0) return new Map();
  const rows = await prisma.slackUser.findMany({
    where: { slackUserId: { in: slackUserIds }, refreshedAt: { gt: new Date(now.getTime() - NAME_FRESH_MS) } },
    select: { slackUserId: true, displayName: true, realName: true },
  });
  return new Map(rows.map((r) => [r.slackUserId, { displayName: r.displayName, realName: r.realName ?? undefined }]));
}

type SlackUserLike = { id?: string; is_bot?: boolean; deleted?: boolean; real_name?: string; name?: string; profile?: { display_name?: string; display_name_normalized?: string } };

function nameOf(u: SlackUserLike, fallback: string): UserName {
  const p = u.profile;
  return { displayName: p?.display_name_normalized || p?.display_name || u.real_name || u.name || fallback, realName: u.real_name ?? undefined };
}

/**
 * Resolve names for `ids`: cache first, then Slack for the rest. Bots and deactivated accounts are left out
 * (they are never owners). An id Slack cannot resolve keeps the id as its name, never blocking the analysis.
 */
export async function resolveUserNames(slack: WebClient, ids: string[], opts: { cache?: (ids: string[]) => Promise<Map<string, UserName>> } = {}): Promise<Map<string, UserName>> {
  const unique = [...new Set(ids)];
  const out = await (opts.cache ?? freshNamesFromDb)(unique);
  let missing = unique.filter((id) => !out.has(id));
  if (missing.length === 0) return out;

  if (missing.length > LIST_THRESHOLD) {
    // One walk of the directory instead of N point lookups. Still paged; 200 per page.
    try {
      const want = new Set(missing);
      let cursor: string | undefined;
      do {
        const page = await slack.users.list({ limit: 200, cursor });
        for (const u of (page.members ?? []) as SlackUserLike[]) {
          if (u.id && want.has(u.id) && !u.is_bot && !u.deleted) out.set(u.id, nameOf(u, u.id));
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      missing = missing.filter((id) => !out.has(id));
    } catch {
      /* fall through to per-id lookups */
    }
  }

  for (const id of missing) {
    try {
      const { user } = await slack.users.info({ user: id });
      const u = user as SlackUserLike | undefined;
      if (!u || u.is_bot || u.deleted) continue;
      out.set(id, nameOf(u, id));
    } catch {
      out.set(id, { displayName: id }); // unknown user: keep the id, never block the analysis
    }
  }
  return out;
}
