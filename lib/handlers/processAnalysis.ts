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
import { addParticipants, buildTranscript, type Participant } from "../analysis/transcript";
import { verifyEvidence } from "../analysis/evidence";
import { SYSTEM_PROMPT, buildUserMessage } from "../analysis/prompt";
import { requesterCursor } from "../analysis/cursor";
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
    // Only messages after THIS requester's cursor (decision #19). Null means they never caught up: whole thread.
    const cursor = await requesterCursor(analysis.threadId, analysis.requestedById);
    const { messages, users } = await slack.readThread(
      { channelId: analysis.thread.channelId, threadTs: analysis.thread.threadTs },
      cursor,
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
    // Everyone we have a fresh name for: authors, mentioned users, and channel members (decision #10
    // addendum). The requester's row gets its real name here too, replacing the shortcut payload's handle.
    const members = await slack.channelMembers(analysis.thread.channelId); // best effort; empty if the scope is missing
    for (const [id, u] of members) if (!users.has(id)) users.set(id, u);
    // One upsert per user, keyed on @@unique([workspaceId, slackUserId]).
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
    const built = buildTranscript(messages, displayNames);
    // The requester's name as Slack knows it (users.info above), or the cached row.
    const requester = { slackUserId: analysis.requestedBy.slackUserId, displayName: displayNames.get(analysis.requestedBy.slackUserId) ?? analysis.requestedBy.displayName };
    // Participants = spoke + mentioned (from the transcript), then the requester, then channel members.
    // Earlier roles win, so a requester who spoke stays "spoke".
    const channelPeople: Participant[] = [...members].map(([slackUserId, u]) => ({ slackUserId, displayName: u.displayName, role: "channel" as const }));
    const transcript = { ...built, participants: addParticipants(addParticipants(built.participants, [{ ...requester, role: "requester" as const }]), channelPeople) };
    const prior = cursor ? await loadPrior(analysis.threadId, analysis.requestedById, analysisId) : undefined;
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

    // Evidence check (Zoey, 2026-11-06): an item whose quote is not in the transcript is an inference. Dropped, logged.
    const { kept, dropped } = verifyEvidence(result.output.actionItems, transcript.transcript);
    if (dropped.length > 0) console.warn(`[analysis ${analysisId}] dropped ${dropped.length} unverified item(s): ${dropped.map((d) => `"${d.task}" (evidence: "${d.evidence}")`).join("; ")}`);
    const matched = kept.map((ai) => {
      const match = matchAssignee(ai.owner, transcript.participants, workspaceUsers);
      console.log(`[analysis ${analysisId}] owner="${ai.owner}" -> ${match.source}${match.candidates.length ? ` candidates=[${match.candidates.map((c) => `${c.displayName}(${c.slackUserId})`).join(", ")}]` : ""}`);
      return { task: ai.task, owner: ai.owner, match };
    });
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
  throughTs: string; // newest ts in this batch; becomes this requester's cursor once the row is DONE
  result: ModelCall<AnalysisOutput>; // what callClaude returned
  items: CarriedItem[]; // action items after matchAssignee, plus any owner carried over from the previous analysis
};

/** This requester's previous DONE analysis of the thread, shaped for the prompt and for carrying owners forward. */
export async function loadPrior(threadId: string, requestedById: string, excludeAnalysisId: string): Promise<PriorAnalysis | undefined> {
  const prev = await prisma.analysis.findFirst({
    where: { threadId, requestedById, status: "DONE", id: { not: excludeAnalysisId } },
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
  //    and the requester's cursor hasn't moved. A retry starts clean.
  // 2. Duplicate drafts are blocked two ways. The `status: "RUNNING"` guard means only one
  //    worker can flip the analysis to DONE (the loser gets count === 0, throws, and rolls back).
  //    Behind that, the unique constraint on Draft(analysisId, type) rejects a second draft
  //    of the same type even if the guard somehow got bypassed.
  // 3. All or nothing matters for the cursor. The requester's cursor IS analysis.throughTs on a DONE
  //    row (decision #19), so it moves in the same statement that marks the results final: no way
  //    for the cursor to advance without the drafts, or the drafts to exist without the cursor.
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

    // 3. Drafts: only the kinds the model suggested, each with its reason (decision #19). Zero rows is a
    //    valid outcome: "nothing for you to send".
    const suggested = (
      [
        ["REPLY", out.drafts.reply],
        ["SUMMARY", out.drafts.summary],
        ["MEETING", out.drafts.meeting],
        ["INVITE", out.drafts.invite],
      ] as const
    ).flatMap(([type, s]) => (s ? [{ analysisId: input.analysisId, type, text: s.text, reason: s.reason }] : []));
    if (suggested.length > 0) await tx.draft.createMany({ data: suggested });

    // 4. The thread-level high-water mark, display only (the real cursor is per requester, derived from
    //    DONE analyses). Only ever moves forward.
    await tx.thread.updateMany({
      where: { id: input.threadId, OR: [{ lastAnalyzedTs: null }, { lastAnalyzedTs: { lt: input.throughTs } }] },
      data: { lastAnalyzedTs: input.throughTs },
    });
  });
}
