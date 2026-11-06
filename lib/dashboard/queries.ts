// Read models for the dashboard. Every query is scoped to the viewer: their workspace, and only the threads
// they requested (lib/dashboard/access.ts).
import { prisma } from "../db";
import { analysisOwnedBy, threadVisibleTo, type Viewer } from "./access";

export type Filter = "all" | "needs-response" | "open-questions";

// Each person sees their own catch-ups of a thread (decision #19), so the analyses are filtered by requester too.
const threadInclude = (viewer: Viewer) => ({
  analyses: {
    where: { requestedById: viewer.userId },
    orderBy: { createdAt: "desc" as const },
    take: 3, // the newest may be a "nothing new" no-op; the page shows the latest DONE one (see pickAnalysis)
    include: {
      requestedBy: { select: { displayName: true } },
      drafts: { orderBy: { type: "asc" as const } },
      actionItems: { include: { assignee: { select: { id: true, displayName: true } } } },
    },
  },
});

export async function listThreads(viewer: Viewer) {
  const threads = await prisma.thread.findMany({ where: threadVisibleTo(viewer), include: threadInclude(viewer), orderBy: { createdAt: "desc" } });
  // Newest activity first: by the latest analysis's createdAt, threads without one last.
  return threads.sort((a, b) => (b.analyses[0]?.createdAt.getTime() ?? 0) - (a.analyses[0]?.createdAt.getTime() ?? 0));
}
export type ThreadRow = Awaited<ReturnType<typeof listThreads>>[number];
export type AnalysisRow = ThreadRow["analyses"][number];
export type DraftRow = AnalysisRow["drafts"][number];
export type ItemRow = AnalysisRow["actionItems"][number];

/** The analysis to show: the newest one, unless it is a "nothing new" no-op, then the newest DONE one. */
export function pickAnalysis(t: ThreadRow): AnalysisRow | undefined {
  const newest = t.analyses[0];
  if (newest?.status === "FAILED" && newest.error?.startsWith("no new messages")) return t.analyses.find((a) => a.status === "DONE") ?? newest;
  return newest;
}

export function matchesFilter(t: ThreadRow, f: Filter): boolean {
  const a = pickAnalysis(t);
  if (f === "needs-response") return a?.needResponse === true;
  if (f === "open-questions") return (a?.openQuestions.length ?? 0) > 0;
  return true;
}

export async function listWorkspaceUsers(workspaceId: string) {
  return prisma.slackUser.findMany({ where: { workspaceId }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } });
}

export async function sidebarCounts(viewer: Viewer) {
  const mine = analysisOwnedBy(viewer);
  const [drafts, items, threads] = await Promise.all([
    prisma.draft.count({ where: { status: "SUGGESTED", analysis: mine } }),
    prisma.actionItem.count({ where: { done: false, analysis: mine } }),
    prisma.thread.count({ where: { workspaceId: viewer.workspaceId, analyses: { some: { requestedById: viewer.userId, drafts: { some: { status: "SUGGESTED" } } } } } }),
  ]);
  return { drafts, items, threads };
}

/** A title for a thread we never stored the text of: the summary's first sentence. */
export function threadTitle(a: AnalysisRow | undefined): string {
  if (!a) return "Not analyzed yet";
  if (a.status === "FAILED") return "Analysis failed";
  if (a.status !== "DONE") return "Analyzing…";
  const first = (a.summary ?? "").split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > 90 ? first.slice(0, 87) + "…" : first || "Untitled thread";
}

export function slackPermalink(domain: string, channelId: string, ts: string): string {
  return `https://${domain}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

export function ago(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Failed Notion exports, keyed by draft id, so the dashboard can say why instead of "creating…" forever. */
export async function failedNotionExports(): Promise<Map<string, string>> {
  const jobs = await prisma.job.findMany({ where: { type: "notion_export", status: "FAILED" }, select: { payload: true, lastError: true } });
  const out = new Map<string, string>();
  for (const j of jobs) {
    const draftId = (j.payload as { draftId?: string })?.draftId;
    if (draftId) out.set(draftId, j.lastError ?? "failed");
  }
  return out;
}
