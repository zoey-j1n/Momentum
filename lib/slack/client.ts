// The one place a Slack Web API client is built. Everything that talks to Slack (reading threads
// in the worker, acking the shortcut, posting drafts in Milestone 6) goes through here.
//
// Single workspace for now: the bot token is the one you copy from the app's "Install App" page
// after loading slack/manifest.json. A token per Workspace row (OAuth install flow) is part of
// decision 9 in Milestone 7; when that lands, only this function changes.
import { WebClient, ErrorCode, type WebAPICallError } from "@slack/web-api";

let cached: WebClient | undefined;

export function slackClient(): WebClient {
  if (cached) return cached;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set (see .env.example)");
  cached = new WebClient(token, {
    timeout: 10_000, // one call, not the whole job; the job lease is 5 minutes
    retryConfig: { retries: 2, minTimeout: 500 }, // transient network failures only; 429s are waited out by the client itself
  });
  return cached;
}

/** Slack's own error string for a failed call (e.g. "channel_not_found"), or null if it was not a Slack platform error. */
export function slackErrorCode(err: unknown): string | null {
  const e = err as WebAPICallError;
  if (e && typeof e === "object" && e.code === ErrorCode.PlatformError) return e.data?.error ?? null;
  return null;
}

/** Errors that will not fix themselves by retrying: the thread or channel is gone, or the bot can't see it. */
export const NON_RETRYABLE_SLACK_ERRORS = new Set([
  "channel_not_found",
  "thread_not_found",
  "not_in_channel",
  "missing_scope",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
]);
