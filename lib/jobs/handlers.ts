// The registry: job type -> handler. The queue dispatches on Job.type and never imports a handler itself.
// Payloads are untrusted JSON from the database, so each handler validates its own with Zod before use.
import { z } from "zod";
import type { Handlers } from "./queue";
import { NonRetryableError } from "./errors";
import { processAnalysis } from "../handlers/processAnalysis";
import { FakeSlackReader, SlackWebReader, type SlackReader } from "../slack/readThread";
import { exportInviteToNotion } from "../handlers/exportToNotion";
import { notionConfigured, RealNotionClient, type NotionClient } from "../notion";

const AnalyzePayload = z.object({ analysisId: z.string().min(1) });
const NotionExportPayload = z.object({ draftId: z.string().min(1) });

export function buildHandlers(slack: SlackReader, notion?: NotionClient): Handlers {
  return {
    analyze: async (payload) => {
      const parsed = AnalyzePayload.safeParse(payload);
      if (!parsed.success) throw new NonRetryableError(`bad analyze payload: ${parsed.error.message}`);
      await processAnalysis(parsed.data.analysisId, slack);
    },
    notion_export: async (payload) => {
      const parsed = NotionExportPayload.safeParse(payload);
      if (!parsed.success) throw new NonRetryableError(`bad notion_export payload: ${parsed.error.message}`);
      if (!notion) throw new NonRetryableError("Notion is not configured on this worker (NOTION_API_KEY / NOTION_DATABASE_ID)");
      await exportInviteToNotion(parsed.data.draftId, notion);
    },
  };
}

// Fake reader (the sample thread) when asked for, or when there is no bot token to use anyway.
// The crash test and enqueue-sample set SLACK_USE_FAKE_READER=1 because their thread does not exist in Slack.
export const usingFakeReader = process.env.SLACK_USE_FAKE_READER === "1" || !process.env.SLACK_BOT_TOKEN;

export const defaultHandlers: Handlers = buildHandlers(
  usingFakeReader ? new FakeSlackReader() : new SlackWebReader(),
  notionConfigured() ? new RealNotionClient() : undefined,
);
