// What the Slack route does after the request is verified and parsed: turn "this person clicked
// Catch up on this message" into a PENDING analysis and a queued job, or explain why not.
// Kept out of the route file so it can be tested without HTTP, signatures, or Next.
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { enqueue } from "../jobs/queue";

// The fields of Slack's `message_action` payload that we use. Everything else Slack sends is ignored.
// This is OUR checklist of what we need; Slack's format is fixed and documented, not derived from this.
export const MessageActionPayload = z.object({
  type: z.literal("message_action"),
  callback_id: z.literal("catch_up"), // the shortcut's id in slack/manifest.json
  team: z.object({ id: z.string().min(1), domain: z.string().optional() }),
  channel: z.object({ id: z.string().min(1) }),
  user: z.object({ id: z.string().min(1), username: z.string().optional(), name: z.string().optional() }),
  message: z.object({
    ts: z.string().min(1), // the clicked message (decision #2: strings, never numbers)
    thread_ts: z.string().optional(), // present only when the clicked message is a reply
  }),
  response_url: z.url(), // where the ephemeral acknowledgement goes (decision #11)
});
export type MessageActionPayload = z.infer<typeof MessageActionPayload>;

export type CatchUpResult =
  | { kind: "queued"; analysisId: string; jobId: string; threadId: string }
  | { kind: "already_queued"; threadId: string } // an analysis is already PENDING or RUNNING for this thread
  | { kind: "caught_up"; threadId: string }; // the clicked message is already covered by the last analysis

export async function catchUp(p: MessageActionPayload): Promise<CatchUpResult> {
  // Slack has no thread ids. A thread is the ts of its first message: thread_ts if we clicked a reply,
  // otherwise the clicked message is the parent and its own ts is the thread.
  const threadTs = p.message.thread_ts ?? p.message.ts;

  // Three upserts, all keyed on Slack's own ids, so repeated clicks find the same rows.
  const workspace = await prisma.workspace.upsert({
    where: { slackTeamId: p.team.id },
    update: {},
    create: { slackTeamId: p.team.id, name: p.team.domain ?? p.team.id },
  });
  const requester = await prisma.slackUser.upsert({
    where: { workspaceId_slackUserId: { workspaceId: workspace.id, slackUserId: p.user.id } },
    update: {}, // the worker refreshes names from users.info; the payload's username is only a first guess
    create: { workspaceId: workspace.id, slackUserId: p.user.id, displayName: p.user.username ?? p.user.name ?? p.user.id },
  });
  const thread = await prisma.thread.upsert({
    where: { workspaceId_channelId_threadTs: { workspaceId: workspace.id, channelId: p.channel.id, threadTs } },
    update: {},
    create: { workspaceId: workspace.id, channelId: p.channel.id, threadTs },
  });

  // Early refusal with no Slack call: the clicked message is at or before the cursor, so the last
  // analysis already covered it. (String compare is valid: Slack ts values have a fixed width.)
  if (thread.lastAnalyzedTs !== null && p.message.ts <= thread.lastAnalyzedTs) {
    return { kind: "caught_up", threadId: thread.id };
  }

  // The analysis row and its job commit together. Without the transaction, a crash between the two
  // inserts would leave a PENDING analysis that no worker will ever pick up, and the partial unique
  // index would then block every future click on this thread.
  try {
    const result = await prisma.$transaction(async (tx) => {
      const analysis = await tx.analysis.create({
        data: { threadId: thread.id, requestedById: requester.id, status: "PENDING" }, // throughTs: null until the worker commits (decision #14)
        select: { id: true },
      });
      const jobId = await enqueue("analyze", { analysisId: analysis.id }, { db: tx });
      return { analysisId: analysis.id, jobId };
    });
    return { kind: "queued", threadId: thread.id, ...result };
  } catch (err) {
    // P2002 = unique violation. The only unique that can fire on this insert is the partial index
    // "one PENDING/RUNNING analysis per thread", i.e. a double click or a repeated delivery.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { kind: "already_queued", threadId: thread.id };
    }
    throw err;
  }
}

/** The one-line ephemeral reply for each outcome. Only the person who clicked sees it (decision #11). */
export function ackText(result: CatchUpResult, dashboardUrl: string): string {
  switch (result.kind) {
    case "queued":
      return `Working on it. Drafts will be ready for review in about a minute: ${dashboardUrl}`;
    case "already_queued":
      return `Already on it. This thread is being analyzed right now: ${dashboardUrl}`;
    case "caught_up":
      return `Nothing new since the last catch-up. Run it on a newer message to analyze what came after.`;
  }
}
