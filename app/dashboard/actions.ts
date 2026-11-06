"use server";
// Server actions behind the dashboard buttons. Each one: read the signed-in person from the session cookie
// (decision #9), call the one module allowed to change state, report back. Errors are returned, not
// thrown, so the UI can show them next to the button instead of a blank error page.
import { revalidatePath } from "next/cache";
import { approveDraft, editDraft, rejectDraft, restoreDraft, TransitionError } from "@/lib/drafts/transitions";
import { sendDraft } from "@/lib/drafts/sendDraft";
import { setAssignee } from "@/lib/actionItems/setAssignee";
import { requireContext } from "@/lib/dashboard/workspace";
import { AccessError, assertActionItemAccess, assertDraftAccess } from "@/lib/dashboard/access";
import { AuthError } from "@/lib/auth/session";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

// The workspace and actor come from the cookie, never from the form. Then the authorization check: the
// draft must be on a thread this person requested (lib/dashboard/access.ts), the same rule that decides
// what the page lists. The transitions themselves are additionally scoped by workspaceId.
async function context(draftId: string) {
  const ctx = await requireContext();
  const viewer = { workspaceId: ctx.workspaceId, userId: ctx.user.id };
  await assertDraftAccess(draftId, viewer);
  return { workspaceId: ctx.workspaceId, actorId: ctx.user.id };
}

function report(err: unknown): ActionResult {
  if (err instanceof AuthError) return { ok: false, error: "Your session expired. Reload and sign in again." };
  if (err instanceof AccessError) return { ok: false, error: "This isn't on a thread you requested." };
  if (err instanceof TransitionError) return { ok: false, error: "This draft changed under you. Reload to see its current state." };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export async function saveDraftText(draftId: string, text: string): Promise<ActionResult> {
  try {
    const { workspaceId, actorId } = await context(draftId);
    await editDraft(draftId, workspaceId, actorId, text);
    revalidatePath("/dashboard");
    return { ok: true, message: "Saved" };
  } catch (e) {
    return report(e);
  }
}

export async function rejectDraftAction(draftId: string): Promise<ActionResult> {
  try {
    const { workspaceId, actorId } = await context(draftId);
    await rejectDraft(draftId, workspaceId, actorId);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (e) {
    return report(e);
  }
}

export async function restoreDraftAction(draftId: string): Promise<ActionResult> {
  try {
    const { workspaceId, actorId } = await context(draftId);
    await restoreDraft(draftId, workspaceId, actorId);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (e) {
    return report(e);
  }
}

/** Approve and post. If `text` differs from what is stored, it is saved first: approval covers the exact text. */
export async function approveAndSend(draftId: string, text: string): Promise<ActionResult> {
  try {
    const { workspaceId, actorId } = await context(draftId);
    const result = await sendDraft(draftId, workspaceId, actorId, text);
    revalidatePath("/dashboard");
    switch (result.outcome) {
      case "posted": return { ok: true, message: "Posted to Slack" };
      case "failed": return { ok: false, error: `Slack rejected it: ${result.reason}. You can retry.` };
      case "unknown": return { ok: false, error: "Slack did not answer in time. The reconciler will settle it within a minute or two." };
      case "busy": return { ok: false, error: "Someone else is posting this draft right now." };
    }
  } catch (e) {
    return report(e);
  }
}

export async function setAssigneeAction(actionItemId: string, assigneeId: string | null): Promise<ActionResult> {
  try {
    const ctx = await requireContext();
    await assertActionItemAccess(actionItemId, { workspaceId: ctx.workspaceId, userId: ctx.user.id });
    await setAssignee(actionItemId, ctx.workspaceId, ctx.user.id, assigneeId);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (e) {
    return report(e);
  }
}

/** Legacy export kept so nothing else needs to import approveDraft directly. */
export async function approveOnly(draftId: string): Promise<ActionResult> {
  try {
    const { workspaceId, actorId } = await context(draftId);
    await approveDraft(draftId, workspaceId, actorId);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (e) {
    return report(e);
  }
}
