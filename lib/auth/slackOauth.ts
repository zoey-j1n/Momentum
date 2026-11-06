// Sign in with Slack, the OAuth v2 way (decision #9). Not OpenID Connect: we need the person's own
// chat:write token (decision #15), and only the OAuth v2 flow with user_scope returns one.
//
// Flow: /api/slack/oauth/start sends the browser to authorizeUrl() with a random state. Slack asks the
// person to allow "send messages on your behalf" and redirects to /api/slack/oauth/callback?code&state.
// The callback checks the state against its cookie, then exchangeCode() trades the code for an identity
// SERVER-SIDE with the client secret. The browser never tells us who it is; Slack does.
// completeSignIn() is the database half: refuse foreign teams, upsert the rows, store the encrypted token.
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { prisma } from "../db";
import { encryptToken } from "../crypto/tokens";
import { slackClient } from "../slack/client";

export const OAUTH_STATE_COOKIE = "momentum_oauth_state";
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
export const USER_SCOPES = ["chat:write"];

export class OAuthError extends Error {}

export type OAuthConfig = { clientId: string; clientSecret: string; teamId: string; redirectUri: string };

export function oauthConfig(): OAuthConfig {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const teamId = process.env.SLACK_TEAM_ID;
  const base = process.env.NEXT_PUBLIC_BASE_URL;
  if (!clientId || !clientSecret || !teamId || !base) {
    throw new OAuthError("SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_TEAM_ID and NEXT_PUBLIC_BASE_URL must all be set (see .env.example)");
  }
  return { clientId, clientSecret, teamId, redirectUri: `${base.replace(/\/$/, "")}/api/slack/oauth/callback` };
}

/** Where the browser goes to authorize. `team` pre-selects the workspace; the callback still enforces it. */
export function authorizeUrl(cfg: OAuthConfig, state: string): string {
  const u = new URL("https://slack.com/oauth/v2/authorize");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("user_scope", USER_SCOPES.join(","));
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("team", cfg.teamId);
  return u.toString();
}

// What Slack tells us about the person, after the code exchange. Everything the rest of sign-in needs.
export type SignInIdentity = { teamId: string; teamName?: string; slackUserId: string; accessToken: string; scopes: string[] };

const AccessResponse = z.object({
  ok: z.literal(true),
  team: z.object({ id: z.string(), name: z.string().optional() }),
  authed_user: z.object({ id: z.string(), access_token: z.string(), scope: z.string().optional() }),
});

/** Trade the one-time code for an identity. Server-to-server: this is the only place the client secret is used. */
export async function exchangeCode(cfg: OAuthConfig, code: string): Promise<SignInIdentity> {
  const res = await new WebClient(undefined, { timeout: 10_000, retryConfig: { retries: 0 } }).oauth.v2.access({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
  });
  const parsed = AccessResponse.safeParse(res);
  if (!parsed.success) throw new OAuthError("Slack's oauth.v2.access response did not include a user token");
  const { team, authed_user } = parsed.data;
  return { teamId: team.id, teamName: team.name, slackUserId: authed_user.id, accessToken: authed_user.access_token, scopes: authed_user.scope?.split(",") ?? [] };
}

export type SignInResult = { workspaceId: string; userId: string };
type Deps = { lookupName?: (slackUserId: string) => Promise<{ displayName: string; realName?: string } | null> };

/**
 * The database half of sign-in. Refuses any team but ours (single workspace, decision #9), makes sure the
 * Workspace and SlackUser rows exist, and stores the encrypted token on the user. Idempotent: signing in
 * again replaces the token and touches nothing else.
 */
export async function completeSignIn(identity: SignInIdentity, allowedTeamId: string, deps: Deps = { lookupName: lookupNameFromSlack }): Promise<SignInResult> {
  if (identity.teamId !== allowedTeamId) throw new OAuthError("This Momentum is private to one Slack workspace, and yours is not it.");
  for (const scope of USER_SCOPES) {
    if (!identity.scopes.includes(scope)) throw new OAuthError(`Slack did not grant the ${scope} permission; try again and click Allow.`);
  }
  const userTokenEnc = encryptToken(identity.accessToken); // encrypt before any DB write; a crypto misconfig fails here, not half-way

  const workspace = await prisma.workspace.upsert({
    where: { slackTeamId: identity.teamId },
    update: identity.teamName ? { name: identity.teamName } : {},
    create: { slackTeamId: identity.teamId, name: identity.teamName ?? identity.teamId },
  });
  // Best effort, outside any transaction (network call): a nicer display name than the raw id.
  const name = (await deps.lookupName?.(identity.slackUserId).catch(() => null)) ?? null;
  const user = await prisma.slackUser.upsert({
    where: { workspaceId_slackUserId: { workspaceId: workspace.id, slackUserId: identity.slackUserId } },
    update: { userTokenEnc, userTokenUpdatedAt: new Date(), ...(name ? { displayName: name.displayName, realName: name.realName } : {}) },
    create: { workspaceId: workspace.id, slackUserId: identity.slackUserId, displayName: name?.displayName ?? identity.slackUserId, realName: name?.realName, userTokenEnc, userTokenUpdatedAt: new Date() },
  });
  return { workspaceId: workspace.id, userId: user.id };
}

async function lookupNameFromSlack(slackUserId: string) {
  const res = await slackClient().users.info({ user: slackUserId });
  const u = res.user;
  if (!u) return null;
  return { displayName: u.profile?.display_name || u.real_name || u.name || slackUserId, realName: u.real_name ?? undefined };
}
