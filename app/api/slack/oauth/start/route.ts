// Step 1 of sign-in: remember a random state in a short-lived cookie, send the browser to Slack.
// The state is what stops login CSRF: the callback only accepts a code if Slack echoes this exact value back.
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl, oauthConfig, OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS } from "@/lib/auth/slackOauth";

export async function GET() {
  const cfg = oauthConfig();
  const state = randomBytes(16).toString("hex");
  (await cookies()).set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
  return NextResponse.redirect(authorizeUrl(cfg, state));
}
