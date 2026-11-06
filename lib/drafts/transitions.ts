// lib/drafts/transitions.ts
// The ONLY module that changes Draft.status. Every transition: conditional updateMany + audit event, one transaction.
import { prisma } from "../db";
import { enqueue } from "../jobs/queue";
import { notionConfigured } from "../notion";

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

export async function restoreDraft(draftId: string, workspaceId: string, actorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.draft.updateMany({
      where: { id: draftId, status: "REJECTED", analysis: { thread: { workspaceId } } },
      data: { status: "SUGGESTED" },
    });
    if (count !== 1) throw new TransitionError(`restore: draft ${draftId} is not REJECTED`);
    await tx.auditEvent.create({
      data: { workspaceId, actorId, entityType: "Draft", entityId: draftId, action: "restore", fromStatus: "REJECTED", toStatus: "SUGGESTED" },
    });
  });
}

export async function approveDraft(draftId: string, workspaceId: string, actorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.draft.updateMany({
      where: { id: draftId, status: "SUGGESTED", analysis: { thread: { workspaceId } } },
      data: { 
        status: "APPROVED",
        approvedById: actorId, 
        approvedAt: new Date()
     },
    });
    if (count !== 1) throw new TransitionError(`approve: draft ${draftId} is not SUGGESTED`);
    await tx.auditEvent.create({
      data: { workspaceId, actorId, entityType: "Draft", entityId: draftId, action: "approve", fromStatus: "SUGGESTED", toStatus: "APPROVED" },
    });
  });
}

// Editing only changes the text; status stays SUGGESTED. Approval locks the exact words, so APPROVED is not editable.
export async function editDraft(draftId: string, workspaceId: string, actorId: string, text: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.draft.updateMany({
      where: { id: draftId, status: "SUGGESTED", analysis: { thread: { workspaceId } } },
      data: { text },
    });
    if (count !== 1) throw new TransitionError(`edit: draft ${draftId} is not SUGGESTED`);
    await tx.auditEvent.create({
      data: { workspaceId, actorId, entityType: "Draft", entityId: draftId, action: "edit", fromStatus: "SUGGESTED", toStatus: "SUGGESTED" },
    });
  });
}

// Soft delete. Reversible via restoreDraft.
export async function rejectDraft(draftId: string, workspaceId: string, actorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.draft.updateMany({
      where: { id: draftId, status: "SUGGESTED", analysis: { thread: { workspaceId } } },
      data: { status: "REJECTED" },
    });
    if (count !== 1) throw new TransitionError(`reject: draft ${draftId} is not SUGGESTED`);
    await tx.auditEvent.create({
      data: { workspaceId, actorId, entityType: "Draft", entityId: draftId, action: "reject", fromStatus: "SUGGESTED", toStatus: "REJECTED" },
    });
  });
}

// Called after Slack confirms. System action, so actorId is null. POSTED is final.
export async function markPosted(draftId: string, workspaceId: string, slackMessageTs: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.draft.updateMany({
      where: { id: draftId, status: "POSTING", analysis: { thread: { workspaceId } } },
      data: { status: "POSTED", slackMessageTs, postedAt: new Date() },
    });
    if (count !== 1) throw new TransitionError(`markPosted: draft ${draftId} is not POSTING`);
    await tx.auditEvent.create({
      data: { workspaceId, actorId: null, entityType: "Draft", entityId: draftId, action: "posted", fromStatus: "POSTING", toStatus: "POSTED" },
    });
    // Decision #18: a posted invite gets a Notion meeting page. The job row commits with the status change,
    // so "POSTED invite with no export job" cannot exist. The worker does the Notion call, never this code.
    if (notionConfigured()) {
      const d = await tx.draft.findUniqueOrThrow({ where: { id: draftId }, select: { type: true } });
      if (d.type === "INVITE") await enqueue("notion_export", { draftId }, { db: tx });
    }
  });
}

// Called when Slack clearly failed, or the reconciler found no message. Safe to claim again.
export async function markFailed(draftId: string, workspaceId: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.draft.updateMany({
      where: { id: draftId, status: "POSTING", analysis: { thread: { workspaceId } } },
      data: { status: "FAILED", lastError: reason },
    });
    if (count !== 1) throw new TransitionError(`markFailed: draft ${draftId} is not POSTING`);
    await tx.auditEvent.create({
      data: { workspaceId, actorId: null, entityType: "Draft", entityId: draftId, action: "failed", fromStatus: "POSTING", toStatus: "FAILED" },
    });
  });
}

// The send gate. APPROVED (first send) or FAILED (retry) -> POSTING. Returns false if someone else got there first.
// The read is only to record fromStatus; the updateMany's `where` is the guard.
export async function claimDraft(draftId: string, workspaceId: string, actorId: string): Promise<boolean> {
  return await prisma.$transaction(async (tx) => {
    let from: "APPROVED" | "FAILED" | null = null;
    const first = await tx.draft.updateMany({
      where: { id: draftId, status: "APPROVED", analysis: { thread: { workspaceId } } },
      data: { status: "POSTING", lastError: null },
    });
    if (first.count === 1) {
      from = "APPROVED";
    }
    if (!from){
      const second = await tx.draft.updateMany({
        where: { id: draftId, status: "FAILED", analysis: { thread: { workspaceId } } },
        data: { status: "POSTING", lastError: null },
      });
      if (second.count === 1) {
        from = "FAILED";
      }
    }
    if (!from) return false; // not APPROVED or FAILED: nothing changed, so no audit event
    await tx.auditEvent.create({
      data: { workspaceId, actorId, entityType: "Draft", entityId: draftId, action: "claim", fromStatus: from, toStatus: "POSTING" },
    });
    return true
  });
}
