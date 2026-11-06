// Re-analysis with memory (decision #17). When a thread has been analyzed before, the worker reads only
// the new messages but hands Claude the previous result, and carries human decisions forward.
import type { Match } from "./matchAssignees";

export type PriorItem = {
  task: string;
  assigneeId: string | null;
  assigneeSlackUserId: string | null;
  assigneeConfirmed: boolean;
  assignmentSource: "THREAD_ID" | "THREAD_NAME" | "NAME_MATCH" | "MANUAL" | "NONE";
  done: boolean;
};

export type PriorAnalysis = {
  summary: string;
  decision: string;
  nextStep: string;
  openQuestions: string[];
  actionItems: PriorItem[];
  postedDrafts: string[]; // texts already posted to the thread; the model must not propose them again
};

export type NewItem = { task: string; owner: string; match: Match };
export type CarriedItem = NewItem & { carried?: { assigneeId: string | null; done: boolean } };

const key = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();

/**
 * A reviewer's confirmed owner survives re-analysis: if a new item has the same task text as a previous
 * item whose owner a human set, keep that owner (and the done flag). Matching is exact on normalized
 * text, on purpose: a reworded task is a new decision for the reviewer, not a guess for us.
 */
export function carryOverAssignees(items: NewItem[], prior: PriorItem[]): CarriedItem[] {
  const byTask = new Map(prior.map((p) => [key(p.task), p]));
  return items.map((item) => {
    const p = byTask.get(key(item.task));
    if (!p || !p.assigneeConfirmed) return item;
    return { ...item, carried: { assigneeId: p.assigneeId, done: p.done } };
  });
}
