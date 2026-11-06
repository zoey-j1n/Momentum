// Step 2 of sign-in: Slack sends the browser back here with ?code=...&state=...
// Order matters: check the state first (cheap, no network), then exchange the code (one call to Slack with
// the client secret), then write to the database, then hand out the session cookie. Any failure goes back
// to /login with a reason; nothing is written before the identity is confirmed.
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { completeSignIn, exchangeCode, oauthConfig, OAuthError, OAUTH_STATE_COOKIE } from "@/lib/auth/slackOauth";
import { createSession } from "@/lib/auth/session";

function sameState(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function GET(req: NextRequest) {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(req.url).origin;
  const fail = (reason: string) => {
    console.warn(`[slack oauth] sign-in failed: ${reason}`);
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(reason)}`, base));
  };

  const params = new URL(req.url).searchParams;
  const jar = await cookies();
  const expectedState = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE); // one attempt per state, whatever happens next

  const slackError = params.get("error");
  if (slackError) return fail(slackError === "access_denied" ? "You cancelled the Slack authorization." : `Slack returned "${slackError}".`);

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || !expectedState || !sameState(state, expectedState)) {
    return fail("This sign-in link expired or did not match. Start again.");
  }

  try {
    const cfg = oauthConfig();
    const identity = await exchangeCode(cfg, code);
    const { workspaceId, userId } = await completeSignIn(identity, cfg.teamId);
    await createSession({ workspaceId, userId });
    return NextResponse.redirect(new URL("/dashboard", base));
  } catch (e) {
    if (e instanceof OAuthError) return fail(e.message);
    console.error("[slack oauth]", e);
    return fail("Sign-in failed on our side. Try again.");
  }
}
