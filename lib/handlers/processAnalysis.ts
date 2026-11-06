/**
 * The job handler for one Analysis. The queue calls this; it may call it MORE THAN ONCE for the same id
 * (crash before the job was marked done, lease expired, retry after an error). So every step must be safe
 * to repeat, and the only thing that "counts" is the single transaction in step 5.
 *
 * Contract with the queue (lib/jobs, coming next):
 *   - return normally  -> the job is complete
 *   - throw            -> the queue retries with backoff, up to MAX_ATTEMPTS, then marks the job FAILED
 *   - throw a NonRetryableError -> the queue marks the job FAILED immediately (refusal, bad schema)
 */
import { prisma } from "../db";
import { buildTranscript } from "../analysis/transcript";
import { SYSTEM_PROMPT, buildUserMessage } from "../analysis/prompt";
import { AnalysisOutput } from "../analysis/schema";
import { callClaude, ModelCall, ModelOutputError } from "../analysis/client";
import { matchAssignee } from "../analysis/matchAssignees";
import { carryOverAssignees, type CarriedItem, type PriorAnalysis } from "../analysis/prior";
import type { SlackReader } from "../slack/readThread";
import { Prisma } from "@/generated/prisma/client";
import { NonRetryableError } from "../jobs/errors";

export const MAX_ATTEMPTS = 3; // must match Job.maxAttempts for analyze jobs (the queue is the one that enforces it)
export { NonRetryableError };

export async function processAnalysis(analysisId: string, slack: SlackReader): Promise<void> {
  // ---- Step 1: claim the analysis row ------------------------------------------------------------------
  // Mark RUNNING and increment attempts in ONE updateMany, guarded by status.
  // PENDING is the first run; RUNNING is a retry after a crash. DONE and FAILED are left alone.
  const { count } = await prisma.analysis.updateMany({
    where: { id: analysisId, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "RUNNING", attempts: { increment: 1 } },
  });
  if (count === 0) {
    return; // the idempotent no-op: already finished, or failed for good
  }

  // AT THIS POINT TWO WORKERS CAN BOTH PASS STEP 1 FOR THE SAME ID BECAUSE RUNNING -> RUNNING IS ALLOWED.
  // The queue's claim (one job row to one worker until the lease expires) makes that overlap rare;
  // step 5's conditional update to DONE makes it harmless.
  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    include: { thread: true, requestedBy: { select: { displayName: true, slackUserId: true } } },
  });
  if (!analysis) {
    throw new NonRetryableError(`analysis ${analysisId} disappeared after the update`);
  }
  const workspaceId = analysis.thread.workspaceId;

  // Steps 1 and the findUnique stay outside the try: if they fail there is no RUNNING row to record
  // an error on, and the catch needs `analysis.attempts`.
  try {
    // ---- Step 2: fetch the thread ---------------------------------------------------------------------
    // Only messages after the cursor. Null cursor means the whole thread.
    const { messages, users } = await slack.readThread(
      { channelId: analysis.thread.channelId, threadTs: analysis.thread.threadTs },
      analysis.thread.lastAnalyzedTs,
    );

    // Edge case: nothing new since the cursor. Retrying cannot change that, so fail for good with a
    // clear reason. Milestone 5's ingress will catch this earlier by comparing timestamps; this is the net.
    if (messages.length === 0) {
      throw new NonRetryableError("no new messages since the last analysis");
    }

    // The newest ts in this batch becomes the cursor. Slack ts are fixed-width strings, so string order
    // is time order. Never Number() them (decision #2).
    const throughTs = messages.reduce((max, m) => (m.ts.localeCompare(max) > 0 ? m.ts : max), messages[0].ts);

    // ---- Step 3: upsert SlackUsers --------------------------------------------------------------------
    // One upsert per user seen in the thread, keyed on @@unique([workspaceId, slackUserId]).
    // Outside the transaction on purpose: it is idempotent and must not hold a transaction open across
    // the network call in step 4. A loop is fine for a thread's handful of people; a thread with hundreds
    // of participants would want one createMany with skipDuplicates plus a batched update.
    for (const [slackUserId, u] of users) {
      await prisma.slackUser.upsert({
        where: { workspaceId_slackUserId: { workspaceId, slackUserId } },
        create: { workspaceId, slackUserId, displayName: u.displayName, realName: u.realName ?? null },
        update: { displayName: u.displayName, realName: u.realName ?? null, refreshedAt: new Date() },
      });
    }

    // Two views of the same people: a name map for the transcript, and the matcher's candidate list.
    // The matcher's list is every user in the workspace, not just the thread (decision #5, rule 3).
    const displayNames = new Map([...users].map(([id, u]) => [id, u.displayName]));
    const workspaceUsers = await prisma.slackUser.findMany({
      where: { workspaceId },
      select: { id: true, slackUserId: true, displayName: true },
    });

    // ---- Step 4: Claude + matching --------------------------------------------------------------------
    // NEVER inside a transaction (CLAUDE.md).
    const transcript = buildTranscript(messages, displayNames);
    const prior = analysis.thread.lastAnalyzedTs ? await loadPrior(analysis.threadId, analysisId) : undefined;
    // The requester's name as the thread knows it, if they spoke in it; the cached row otherwise.
    const requester = { slackUserId: analysis.requestedBy.slackUserId, displayName: displayNames.get(analysis.requestedBy.slackUserId) ?? analysis.requestedBy.displayName };
    const userMessage = buildUserMessage(transcript, prior, requester);

    let result: ModelCall<AnalysisOutput>;
    try {
      result = await callClaude({ system: SYSTEM_PROMPT, user: userMessage, schema: AnalysisOutput });
    } catch (err) {
      // A refusal or a max_tokens cutoff will not succeed on retry. Everything else (timeout, 5xx,
      // rate limit) passes through and the queue retries it with backoff.
      if (err instanceof ModelOutputError && !err.retryable) throw new NonRetryableError(err.message);
      throw err;
    }

    const matched = result.output.actionItems.map((ai) => ({
      task: ai.task,
      owner: ai.owner,
      match: matchAssignee(ai.owner, transcript.participants, workspaceUsers),
    }));
    // A reviewer's confirmed owner outranks the model's new guess for the same task (decision #17).
    const items = prior ? carryOverAssignees(matched, prior.actionItems) : matched;

    // ---- Step 5: the one transaction ------------------------------------------------------------------
    await commitAnalysis({ analysisId, threadId: analysis.threadId, throughTs, result, items });
  } catch (err) {
    // ---- Step 6: failure --------------------------------------------------------------------------------
    // Record what happened on the analysis, then rethrow so the queue decides retry vs poison.
    // A retried analysis stays RUNNING: step 1's guard already allows it, so no extra write is needed.
    // The `status: "RUNNING"` guard here means a race loser cannot overwrite a winner's DONE.
    const message = err instanceof Error ? err.message : String(err);
    const giveUp = err instanceof NonRetryableError || analysis.attempts >= MAX_ATTEMPTS; // attempts is post-increment
    await prisma.analysis.updateMany({
      where: { id: analysisId, status: "RUNNING" },
      data: giveUp ? { status: "FAILED", error: message } : { error: message },
    });
    throw err;
  }
}

// Everything step 5 needs, as plain data, so the commit can be tested without Slack or Claude.
export type CommitInput = {
  analysisId: string;
  threadId: string;
  throughTs: string; // newest ts in this batch; becomes the thread's new cursor
  result: ModelCall<AnalysisOutput>; // what callClaude returned
  items: CarriedItem[]; // action items after matchAssignee, plus any owner carried over from the previous analysis
};

/** The previous DONE analysis of this thread, shaped for the prompt and for carrying owners forward. */
export async function loadPrior(threadId: string, excludeAnalysisId: string): Promise<PriorAnalysis | undefined> {
  const prev = await prisma.analysis.findFirst({
    where: { threadId, status: "DONE", id: { not: excludeAnalysisId } },
    orderBy: { createdAt: "desc" },
    include: { actionItems: { include: { assignee: { select: { slackUserId: true } } } }, drafts: { where: { status: "POSTED" }, select: { text: true } } },
  });
  if (!prev) return undefined;
  return {
    summary: prev.summary ?? "",
    decision: prev.decision ?? "",
    nextStep: prev.nextStep ?? "",
    openQuestions: prev.openQuestions,
    actionItems: prev.actionItems.map((i) => ({
      task: i.task,
      assigneeId: i.assigneeId,
      assigneeSlackUserId: i.assignee?.slackUserId ?? null,
      assigneeConfirmed: i.assigneeConfirmed,
      assignmentSource: i.assignmentSource,
      done: i.done,
    })),
    postedDrafts: prev.drafts.map((d) => d.text),
  };
}

export async function commitAnalysis(input: CommitInput): Promise<void> {
  // Why the crash test passes:
  // 1. Everything below runs in one transaction, so it all commits or none of it does.
  //    If we crash halfway, the analysis stays RUNNING, no drafts or action items exist,
  //    and lastAnalyzedTs hasn't moved. A retry starts clean.
  // 2. Duplicate drafts are blocked two ways. The `status: "RUNNING"` guard means only one
  //    worker can flip the analysis to DONE (the loser gets count === 0, throws, and rolls back).
  //    Behind that, the unique constraint on Draft(analysisId, type) rejects a second draft
  //    of the same type even if the guard somehow got bypassed.
  // 3. All or nothing matters for the cursor. If lastAnalyzedTs moved forward but the drafts
  //    didn't save, those messages would be skipped forever. If the drafts saved but the cursor
  //    didn't move, the next run would re-read and re-analyze the same messages, and its commit
  //    would then collide on unique (threadId, throughTs). The cursor has to move in the same
  //    commit as the results it stands for, and analysis.throughTs is written here too, so the
  //    row records exactly what the cursor now points at (decision #14).
  await prisma.$transaction(async (tx) => {
    const out = input.result.output;

    // 1. Claim the analysis: RUNNING -> DONE
    const { count } = await tx.analysis.updateMany({
      where: { id: input.analysisId, status: "RUNNING" },
      data: {
        status: "DONE",
        throughTs: input.throughTs,
        summary: out.summary,
        decision: out.decision,
        nextStep: out.nextStep,
        openQuestions: out.openQuestions,
        needResponse: out.needResponse,
        rawOutput: input.result.raw as Prisma.InputJsonValue,
        model: input.result.model,
        latencyMs: input.result.latencyMs,
        inputTokens: input.result.inputTokens,
        outputTokens: input.result.outputTokens,
        costUsd: input.result.costUsd,
      },
    });
    if (count !== 1) {
      // Intentionally visible as a FAILED job next to a DONE analysis: it means a live worker outran
      // its lease, which is the signal to revisit heartbeats (decision #8).
      throw new NonRetryableError("Lost the race: another worker committed first");
    }

    // 2. Action items
    await tx.actionItem.createMany({
      data: input.items.map((item) => ({
        analysisId: input.analysisId,
        task: item.task,
        assigneeName: item.owner, // verbatim from the model
        assigneeId: item.carried ? item.carried.assigneeId : item.match.assigneeId,
        assignmentSource: item.carried ? "MANUAL" : item.match.source,
        assigneeConfirmed: item.carried !== undefined,
        done: item.carried?.done ?? false,
      })),
    });

    // 3. Drafts: one row per type
    await tx.draft.createMany({
      data: [
        { analysisId: input.analysisId, type: "REPLY", text: out.drafts.reply },
        { analysisId: input.analysisId, type: "SUMMARY", text: out.drafts.summary },
        { analysisId: input.analysisId, type: "MEETING", text: out.drafts.meeting },
        { analysisId: input.analysisId, type: "INVITE", text: out.drafts.invite },
      ],
    });

    // 4. Move the cursor (last, same transaction)
    await tx.thread.update({
      where: { id: input.threadId },
      data: { lastAnalyzedTs: input.throughTs },
    });
  });
}
