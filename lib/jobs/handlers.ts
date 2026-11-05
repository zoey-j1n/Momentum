// The registry: job type -> handler. The queue dispatches on Job.type and never imports a handler itself.
// Payloads are untrusted JSON from the database, so each handler validates its own with Zod before use.
import { z } from "zod";
import type { Handlers } from "./queue";
import { NonRetryableError } from "./errors";
import { processAnalysis } from "../handlers/processAnalysis";
import { FakeSlackReader, type SlackReader } from "../slack/readThread";

const AnalyzePayload = z.object({ analysisId: z.string().min(1) });

export function buildHandlers(slack: SlackReader): Handlers {
  return {
    analyze: async (payload) => {
      const parsed = AnalyzePayload.safeParse(payload);
      if (!parsed.success) throw new NonRetryableError(`bad analyze payload: ${parsed.error.message}`);
      await processAnalysis(parsed.data.analysisId, slack);
    },
  };
}

// Milestone 4: the fake reader returns the sample thread. Milestone 5 swaps in the real one.
export const defaultHandlers: Handlers = buildHandlers(new FakeSlackReader());
