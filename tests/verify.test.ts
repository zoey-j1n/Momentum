// verifySlackRequest, exercised without Slack. The test plays Slack's side: it signs a body with the
// same HMAC recipe and a made-up secret, then checks our function accepts it and rejects variations.
// No database involved; this file never imports tests/db.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackRequest } from "../lib/slack/verify";

const SECRET = "test-signing-secret";
const NOW = 1_762_367_000; // a fixed "current time" in seconds, so tests do not depend on the real clock
const BODY = "payload=%7B%22type%22%3A%22message_action%22%7D";

// What Slack does before sending: sign "v0:{timestamp}:{raw body}" with the shared secret.
function slackSign(body: string, timestamp: string, secret = SECRET): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
}

// Build the two headers the way Next's route handler will hand them to us.
function slackHeaders(body: string, timestamp: string, secret = SECRET): Headers {
  return new Headers({
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": slackSign(body, timestamp, secret),
  });
}

describe("verifySlackRequest", () => {
  it("accepts a request signed with the shared secret", () => {
    const ts = String(NOW);
    expect(verifySlackRequest(BODY, slackHeaders(BODY, ts), SECRET, NOW)).toBe(true);
  });

  it("header names are case-insensitive", () => {
    const ts = String(NOW);
    const headers = new Headers({ "x-slack-request-timestamp": ts, "x-slack-signature": slackSign(BODY, ts) });
    expect(verifySlackRequest(BODY, headers, SECRET, NOW)).toBe(true);
  });

  it("rejects a body that changed after signing (one character)", () => {
    const ts = String(NOW);
    const headers = slackHeaders(BODY, ts); // signed over BODY
    const tampered = BODY.replace("message_action", "message_actioN");
    expect(verifySlackRequest(tampered, headers, SECRET, NOW)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const ts = String(NOW);
    expect(verifySlackRequest(BODY, slackHeaders(BODY, ts, "attacker-guess"), SECRET, NOW)).toBe(false);
  });

  it("rejects a replay: valid signature, timestamp more than 5 minutes old", () => {
    const ts = String(NOW - 600);
    expect(verifySlackRequest(BODY, slackHeaders(BODY, ts), SECRET, NOW)).toBe(false);
  });

  it("tolerates clock skew within 5 minutes, in both directions", () => {
    for (const ts of [String(NOW - 299), String(NOW + 299)]) {
      expect(verifySlackRequest(BODY, slackHeaders(BODY, ts), SECRET, NOW)).toBe(true);
    }
  });

  it("rejects when a header is missing", () => {
    const ts = String(NOW);
    expect(verifySlackRequest(BODY, new Headers({ "X-Slack-Signature": slackSign(BODY, ts) }), SECRET, NOW)).toBe(false);
    expect(verifySlackRequest(BODY, new Headers({ "X-Slack-Request-Timestamp": ts }), SECRET, NOW)).toBe(false);
    expect(verifySlackRequest(BODY, new Headers(), SECRET, NOW)).toBe(false);
  });

  it("rejects a timestamp that is not a number", () => {
    const headers = new Headers({ "X-Slack-Request-Timestamp": "abc", "X-Slack-Signature": slackSign(BODY, "abc") });
    expect(verifySlackRequest(BODY, headers, SECRET, NOW)).toBe(false);
  });

  it("rejects a malformed signature without throwing (length mismatch guards timingSafeEqual)", () => {
    const ts = String(NOW);
    const headers = new Headers({ "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": "v0=short" });
    expect(() => verifySlackRequest(BODY, headers, SECRET, NOW)).not.toThrow();
    expect(verifySlackRequest(BODY, headers, SECRET, NOW)).toBe(false);
  });
});
