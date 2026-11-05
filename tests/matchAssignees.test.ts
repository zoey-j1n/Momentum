// Pure-function tests: no database, no resetDb. Each case is one call and one expected result.
import { describe, expect, it } from "vitest";
import { matchAssignee, type WorkspaceUser } from "../lib/analysis/matchAssignees";

const khoa: WorkspaceUser = { id: "db1", slackUserId: "U0KHOA", displayName: "Khoa" };
const alexChen: WorkspaceUser = { id: "db2", slackUserId: "U0ALEX1", displayName: "Alex Chen" };
const alexRivera: WorkspaceUser = { id: "db3", slackUserId: "U0ALEX2", displayName: "Alex Rivera" };
const workspace = [khoa, alexChen, alexRivera];

// participants only carry what the transcript knows: Slack ID and display name
const inThread = (...users: WorkspaceUser[]) => users.map((u) => ({ slackUserId: u.slackUserId, displayName: u.displayName }));

describe("matchAssignee", () => {
  it("rule 1: a participant's Slack ID -> THREAD_ID", () => {
    const m = matchAssignee("U0KHOA", inThread(khoa, alexChen), workspace);
    expect(m).toEqual({ assigneeId: "db1", source: "THREAD_ID", candidates: [] });
  });

  it("a made-up ID matches nobody -> NONE, no candidates", () => {
    const m = matchAssignee("U0FAKE", inThread(khoa), workspace);
    expect(m).toEqual({ assigneeId: null, source: "NONE", candidates: [] });
  });

  it("an ID that exists in the workspace but was NOT in the thread is not accepted as THREAD_ID", () => {
    // the model may only name owners by ID from the participant list
    const m = matchAssignee("U0ALEX2", inThread(khoa), workspace);
    expect(m.source).not.toBe("THREAD_ID");
    expect(m.assigneeId).toBeNull();
  });

  it("rule 3: a name exactly one workspace user has -> NAME_MATCH", () => {
    const m = matchAssignee("Khoa", inThread(alexChen), workspace);
    expect(m).toEqual({ assigneeId: "db1", source: "NAME_MATCH", candidates: [khoa] });
  });

  it("names are case-insensitive and ignore whitespace and a leading @", () => {
    expect(matchAssignee("  khoa ", inThread(), workspace).assigneeId).toBe("db1");
    expect(matchAssignee("@Khoa", inThread(), workspace).assigneeId).toBe("db1");
  });

  it("rule 2: two Alexes in the workspace, one in the thread -> THREAD_NAME for the one in the thread", () => {
    const m = matchAssignee("Alex", inThread(khoa, alexChen), workspace);
    expect(m.assigneeId).toBe("db2");
    expect(m.source).toBe("THREAD_NAME");
    expect(m.candidates).toEqual([alexChen, alexRivera]); // the picker still sees both
  });

  it("two Alexes in the workspace, neither in the thread -> NONE with both as candidates", () => {
    const m = matchAssignee("Alex", inThread(khoa), workspace);
    expect(m).toEqual({ assigneeId: null, source: "NONE", candidates: [alexChen, alexRivera] });
  });

  it("two Alexes in the workspace, BOTH in the thread -> NONE (never guess between two people)", () => {
    const m = matchAssignee("Alex", inThread(alexChen, alexRivera), workspace);
    expect(m.assigneeId).toBeNull();
    expect(m.source).toBe("NONE");
    expect(m.candidates).toHaveLength(2);
  });

  it("a full display name matches only that person", () => {
    const m = matchAssignee("Alex Rivera", inThread(), workspace);
    expect(m).toEqual({ assigneeId: "db3", source: "NAME_MATCH", candidates: [alexRivera] });
  });

  it('"Team" and empty -> NONE, no candidates', () => {
    expect(matchAssignee("Team", inThread(khoa), workspace)).toEqual({ assigneeId: null, source: "NONE", candidates: [] });
    expect(matchAssignee("", inThread(khoa), workspace)).toEqual({ assigneeId: null, source: "NONE", candidates: [] });
  });

  it('the prose form "Name (ID)" is split: ID used for rule 1, name used for candidates', () => {
    // in the thread: rule 1 wins on the ID
    expect(matchAssignee("Khoa (U0KHOA)", inThread(khoa), workspace).source).toBe("THREAD_ID");
    // not in the thread: the ID is rejected, but the name part still finds the candidate
    const m = matchAssignee("Alex (U0ALEX2)", inThread(khoa), workspace);
    expect(m.source).toBe("NONE");
    expect(m.candidates).toEqual([alexChen, alexRivera]);
  });

  it("a participant ID missing from the workspace cache falls through instead of throwing", () => {
    const m = matchAssignee("U0KHOA", inThread(khoa), [alexChen, alexRivera]);
    expect(m).toEqual({ assigneeId: null, source: "NONE", candidates: [] });
  });
});
