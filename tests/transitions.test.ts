import { beforeEach, describe, expect, it } from "vitest";
import { createDraftFixture, prisma, resetDb } from "./db";
import { approveDraft, claimDraft, editDraft, markFailed, markPosted, rejectDraft, restoreDraft, TransitionError } from "../lib/drafts/transitions";

describe("draft transitions", () => {
  beforeEach(resetDb);

  it("restores a REJECTED draft to SUGGESTED and records it", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture({ status: "REJECTED" });

    await restoreDraft(draftId, workspaceId, userId);

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("SUGGESTED");

    const events = await prisma.auditEvent.findMany({ where: { entityId: draftId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "restore",
      fromStatus: "REJECTED",
      toStatus: "SUGGESTED",
      actorId: userId,
    });
  });

  it("approves a SUGGESTED draft and records who approved it", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture();

    await approveDraft(draftId, workspaceId, userId);

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("APPROVED");
    expect(draft?.approvedById).toBe(userId);
    expect(draft?.approvedAt).not.toBeNull();

    const events = await prisma.auditEvent.findMany({ where: { entityId: draftId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "approve",
      fromStatus: "SUGGESTED",
      toStatus: "APPROVED",
      actorId: userId,
    });
  });

  it("refuses to approve a POSTED draft and writes nothing", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture({ status: "POSTED" });

    await expect(approveDraft(draftId, workspaceId, userId)).rejects.toThrow(TransitionError);

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("POSTED"); // unchanged
    expect(await prisma.auditEvent.count()).toBe(0); // the transaction rolled back; nothing leaked
  });

  it("refuses to approve a draft from another workspace", async () => {
    const { draftId, userId } = await createDraftFixture();

    await expect(approveDraft(draftId, "not-this-workspace", userId)).rejects.toThrow(TransitionError);

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("SUGGESTED");
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("edits a SUGGESTED draft's text without changing its status", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture();

    await editDraft(draftId, workspaceId, userId, "new words");

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.text).toBe("new words");
    expect(draft?.status).toBe("SUGGESTED");
    expect(await prisma.auditEvent.count({ where: { entityId: draftId, action: "edit" } })).toBe(1);
  });

  it("refuses to edit an APPROVED draft (approval covers the exact text)", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture({ status: "APPROVED" });

    await expect(editDraft(draftId, workspaceId, userId, "sneaky change")).rejects.toThrow(TransitionError);

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.text).toBe("hello");
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rejects a SUGGESTED draft and restore brings it back", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture();

    await rejectDraft(draftId, workspaceId, userId);
    expect((await prisma.draft.findUnique({ where: { id: draftId } }))?.status).toBe("REJECTED");

    await restoreDraft(draftId, workspaceId, userId);
    expect((await prisma.draft.findUnique({ where: { id: draftId } }))?.status).toBe("SUGGESTED");

    const actions = (await prisma.auditEvent.findMany({ where: { entityId: draftId }, orderBy: { createdAt: "asc" } })).map((e) => e.action);
    expect(actions).toEqual(["reject", "restore"]);
  });

  it("markPosted moves POSTING to POSTED with the Slack message ts, as a system action", async () => {
    const { draftId, workspaceId } = await createDraftFixture({ status: "POSTING" });

    await markPosted(draftId, workspaceId, "1700000002.000001");

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("POSTED");
    expect(draft?.slackMessageTs).toBe("1700000002.000001");
    expect(draft?.postedAt).not.toBeNull();

    const [event] = await prisma.auditEvent.findMany({ where: { entityId: draftId } });
    expect(event).toMatchObject({ action: "posted", fromStatus: "POSTING", toStatus: "POSTED", actorId: null });
  });

  it("markFailed moves POSTING to FAILED and keeps the reason", async () => {
    const { draftId, workspaceId } = await createDraftFixture({ status: "POSTING" });

    await markFailed(draftId, workspaceId, "slack: channel_not_found");

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("FAILED");
    expect(draft?.lastError).toBe("slack: channel_not_found");
  });

  it("cannot go from SUGGESTED straight to POSTED", async () => {
    const { draftId, workspaceId } = await createDraftFixture();

    await expect(markPosted(draftId, workspaceId, "1700000002.000001")).rejects.toThrow(TransitionError);

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("SUGGESTED");
    expect(draft?.slackMessageTs).toBeNull();
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("claims an APPROVED draft and records the claim", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture({ status: "APPROVED" });

    expect(await claimDraft(draftId, workspaceId, userId)).toBe(true);

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("POSTING");

    const [event] = await prisma.auditEvent.findMany({ where: { entityId: draftId } });
    expect(event).toMatchObject({ action: "claim", fromStatus: "APPROVED", toStatus: "POSTING", actorId: userId });
  });

  it("claims a FAILED draft (retry) and clears lastError", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture({ status: "FAILED" });
    await prisma.draft.update({ where: { id: draftId }, data: { lastError: "slack: timeout" } });

    expect(await claimDraft(draftId, workspaceId, userId)).toBe(true);

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("POSTING");
    expect(draft?.lastError).toBeNull();
    expect((await prisma.auditEvent.findMany({ where: { entityId: draftId } }))[0]?.fromStatus).toBe("FAILED");
  });

  it("will not claim a SUGGESTED draft: nothing posts without approval", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture();

    expect(await claimDraft(draftId, workspaceId, userId)).toBe(false);

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("SUGGESTED");
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  // The double-post proof. Two "send" clicks arrive at the same moment.
  it("two simultaneous claims: exactly one wins", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture({ status: "APPROVED" });

    const results = await Promise.all([
      claimDraft(draftId, workspaceId, userId),
      claimDraft(draftId, workspaceId, userId),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1); // one true, one false, in either order

    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    expect(draft?.status).toBe("POSTING");

    const claims = await prisma.auditEvent.count({ where: { entityId: draftId, action: "claim" } });
    expect(claims).toBe(1); // the loser wrote nothing
  });

  it("ten simultaneous claims: still exactly one wins", async () => {
    const { draftId, workspaceId, userId } = await createDraftFixture({ status: "APPROVED" });

    // Promise.all starts both calls before either finishes
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimDraft(draftId, workspaceId, userId)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { entityId: draftId, action: "claim" } })).toBe(1);
  });
});
