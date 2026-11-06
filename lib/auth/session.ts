// The dashboard session (decision #9): a signed JWT in an HttpOnly cookie. Stateless: no table, nothing to
// look up. The server trusts the cookie because only the server could have signed it, the same idea as
// the Slack signing secret in lib/slack/verify.ts.
//
// Two layers: pure functions (signSession / verifySession) that take the secret and the clock as inputs so
// tests need no Next.js, and thin Next wrappers (createSession / readSession / clearSession) around cookies().
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { z } from "zod";

export const SESSION_COOKIE = "momentum_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days. A signed cookie cannot be revoked early (decision #9 tradeoff 3).

// What we remember about the signed-in person. userId is SlackUser.id (our cuid), not the Slack "U..." id,
// so every query and audit event can use it directly.
export const SessionPayload = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
});
export type Session = z.infer<typeof SessionPayload>;

export class AuthError extends Error {}

function secretBytes(secret = process.env.SESSION_SECRET): Uint8Array {
  if (!secret || secret.length < 32) throw new AuthError("SESSION_SECRET is not set or too short (openssl rand -base64 32)");
  return new TextEncoder().encode(secret);
}

/** Pure: payload + secret + clock -> compact JWT. */
export async function signSession(payload: Session, opts: { secret?: string; nowSeconds?: number; ttlSeconds?: number } = {}): Promise<string> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  return new SignJWT(SessionPayload.parse(payload))
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttlSeconds ?? SESSION_TTL_SECONDS))
    .sign(secretBytes(opts.secret));
}

/** Pure: JWT -> payload, or null if the signature, expiry, or shape is wrong. Never throws on bad input. */
export async function verifySession(token: string, opts: { secret?: string; nowSeconds?: number } = {}): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, secretBytes(opts.secret), {
      algorithms: ["HS256"],
      currentDate: opts.nowSeconds === undefined ? undefined : new Date(opts.nowSeconds * 1000),
    });
    const parsed = SessionPayload.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---- Next.js wrappers (only usable inside a request) ----

export async function createSession(payload: Session): Promise<void> {
  const token = await signSession(payload);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, // page JavaScript cannot read it
    secure: process.env.NODE_ENV === "production", // HTTPS only in prod; localhost is http
    sameSite: "lax", // other sites cannot send it; Slack's redirect back to us is a top-level GET, which Lax allows
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function readSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? verifySession(token) : null;
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** For server actions and API routes: the session, or an AuthError the caller turns into 401 / "sign in". */
export async function requireSession(): Promise<Session> {
  const s = await readSession();
  if (!s) throw new AuthError("not signed in");
  return s;
}
