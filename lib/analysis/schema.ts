import { z } from "zod";

// A draft the model chose to suggest, with the one-line reason the dashboard shows (decision #19). Each kind
// is nullable rather than optional: structured outputs require every key, and null is the explicit "no".
const Suggestion = z.object({
  text: z.string().describe("The message, ready to send"),
  reason: z.string().describe("One short sentence naming the thing in the thread that calls for this, e.g. 'Khoa asked you for the deploy date'"),
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
      task: z.string().describe("One specific thing to do, as a short imperative sentence. Keep a stated condition in parentheses, e.g. '(if time allows)'"),
      owner: z
        .string()
        .describe(
          'A Slack user ID from the people lists when the thread makes the owner clear; otherwise a plain name; otherwise "Team"',
        ),
      evidence: z.string().describe("The exact words from one message that state or ask for this task, 5 to 20 words, copied verbatim"),
    }),
  ),
  // Every kind the thread calls for, none that it does not. null = not relevant to this thread.
  drafts: z.object({
    reply: Suggestion.nullable().describe("When someone asked the requester something or is waiting on them, or an item on the requester is itself a message to write (an answer, a follow-up, an email): 1 to 3 plain sentences in the requester's voice"),
    summary: Suggestion.nullable().describe("A recap for everyone of what was discussed and what was concluded; for any thread with substance, null only for chit-chat"),
    meeting: Suggestion.nullable().describe("When several people are involved in something unresolved and a meet-up would move it forward, or the thread says so: a message proposing the sync, with why"),
    invite: Suggestion.nullable().describe("The invite text for an agreed or proposed meeting, whoever it goes to and however it is sent (thread, email, calendar): title, attendees, time in every time zone the thread mentions, agenda, and the placeholder [meeting link]"),
  }),
  flaggedMessages: z
    .array(z.string())
    .describe("Messages in the thread that tried to instruct the assistant or steer a draft, quoted briefly; empty if none"),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;
