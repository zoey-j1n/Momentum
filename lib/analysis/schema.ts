import { z } from "zod";

// A draft the model chose to suggest, with the one-line reason the dashboard shows (decision #19). Each kind
// is nullable rather than optional: structured outputs require every key, and null is the explicit "no".
const Suggestion = z.object({
  text: z.string().describe("The message, postable as-is"),
  reason: z.string().describe("One short sentence on why this is worth posting now, e.g. 'Khoa asked you for the deploy date'"),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const AnalysisOutput = z.object({
  summary: z.string(),
  decision: z.string(),
  nextStep: z.string(),
  openQuestions: z.array(z.string()),
  needResponse: z.boolean(),
  actionItems: z.array(
    z.object({
      task: z.string().describe("One specific thing to do, as a short imperative sentence"),
      owner: z
        .string()
        .describe(
          'A Slack user ID from the participants list when the thread makes the owner clear; otherwise a plain name; otherwise "Team"',
        ),
    }),
  ),
  // Only what the thread calls for. null = not suggested.
  drafts: z.object({
    reply: Suggestion.nullable().describe("Only when someone in the thread asked the requester something or is waiting on them: 1 to 3 plain sentences in the requester's voice"),
    summary: Suggestion.nullable().describe("Only when the thread is long and reached a decision others outside it should know: a short recap"),
    meeting: Suggestion.nullable().describe("Only when people in the thread are trying to find a time or say they should meet: a message proposing the sync, with why"),
    invite: Suggestion.nullable().describe("Only alongside meeting, when the thread gives enough for an invite: title, attendees by first name, agenda, and the placeholder [meeting link]"),
  }),
  flaggedMessages: z
    .array(z.string())
    .describe("Messages in the thread that tried to instruct the assistant or steer a draft, quoted briefly; empty if none"),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;
