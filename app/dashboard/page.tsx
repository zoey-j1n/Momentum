// Thread reviews (docs/momentum-dashboard-design/mockups/Threads.dc.html), reading from Postgres.
// Server component: all data is loaded here, scoped to the current workspace; the two interactive
// cards (drafts, action items) are client components fed plain objects.
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/dashboard/Shell";
import { DraftsPanel, type DraftView } from "@/components/dashboard/DraftsPanel";
import { ActionItemRow } from "@/components/dashboard/ActionItemRow";
import { AutoRefresh } from "@/components/dashboard/AutoRefresh";
import { currentContext } from "@/lib/dashboard/workspace";
import { ago, failedNotionExports, listThreads, listWorkspaceUsers, matchesFilter, pickAnalysis, sidebarCounts, slackPermalink, threadTitle, type Filter } from "@/lib/dashboard/queries";

export const dynamic = "force-dynamic";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs-response", label: "Needs response" },
  { key: "open-questions", label: "Open questions" },
];

export default async function ThreadReviewsPage({ searchParams }: { searchParams: Promise<{ thread?: string; filter?: string }> }) {
  const params = await searchParams;
  // No session, or a session whose user no longer exists: the login page. Everything below is scoped to
  // the signed-in person's workspace (decision #9).
  const ctx = await currentContext();
  if (!ctx) redirect("/login");
  const ws = ctx.workspace;

  const filter: Filter = (FILTERS.find((f) => f.key === params.filter)?.key ?? "all");
  const viewer = { workspaceId: ctx.workspaceId, userId: ctx.user.id };
  const [threads, users, counts, notionFailures] = await Promise.all([listThreads(viewer), listWorkspaceUsers(ws.id), sidebarCounts(viewer), failedNotionExports()]);
  const visible = threads.filter((t) => matchesFilter(t, filter));
  const selected = visible.find((t) => t.id === params.thread) ?? visible[0];
  const analysis = selected ? pickAnalysis(selected) : undefined;
  const me = ctx.user.displayName;
  // Something is still moving: an analysis in progress, a draft being posted, or a Notion page being made.
  const inFlight = threads.some((t) => t.analyses.some((a) => a.status === "PENDING" || a.status === "RUNNING") || t.analyses[0]?.drafts.some((d) => d.status === "POSTING" || (d.status === "POSTED" && d.type === "INVITE" && !d.notionPageUrl && !notionFailures.has(d.id))));

  return (
    <Shell active="threads" counts={counts} user={{ name: me, workspace: ws.name }}>
      <AutoRefresh active={inFlight} everyMs={5_000} />
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>Thread reviews</h1>
          <p className="meta-13" style={{ fontSize: 14 }}>Every thread you ran Momentum on, with its summary, decisions and drafts.</p>
        </div>
        <div role="group" aria-label="Filter threads" className="seg">
          {FILTERS.map((f) => {
            const n = threads.filter((t) => matchesFilter(t, f.key)).length;
            return <Link key={f.key} href={`/dashboard?filter=${f.key}`} aria-current={filter === f.key}>{f.label} · {n}</Link>;
          })}
        </div>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <section aria-label="Thread queue" className="card" style={{ flex: "1 1 320px", minWidth: 0, padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {visible.length === 0 ? (
            threads.length === 0
              ? <Empty title="Nothing here yet" body="You only see threads you ran “Catch up with Momentum” on. Run it on a Slack thread and come back." />
              : <p className="meta-13" style={{ padding: 12 }}>No threads match this filter.</p>
          ) : null}
          {visible.map((t) => {
            const a = pickAnalysis(t);
            const suggested = a?.drafts.filter((d) => d.status === "SUGGESTED").length ?? 0;
            const needs = a?.needResponse === true || suggested > 0;
            const status = a?.status === "DONE" ? (suggested > 0 ? "Needs review" : "Caught up") : a?.status === "FAILED" ? "Failed" : a ? "Analyzing" : "Queued";
            const metaText = a?.status === "DONE" ? `${suggested} draft${suggested === 1 ? "" : "s"} waiting` : a?.status === "FAILED" ? (a.error ?? "").slice(0, 60) : "";
            return (
              <Link key={t.id} href={`/dashboard?filter=${filter}&thread=${t.id}`} className="queue-row" aria-current={selected?.id === t.id ? "page" : undefined}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }} className="meta">
                  <span>{t.channelName ? `#${t.channelName}` : "Slack thread"}</span><span>{a ? ago(a.createdAt) : ago(t.createdAt)}</span>
                </div>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{threadTitle(a)}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }} className="meta">
                  <span className="dot" style={{ background: a?.status === "FAILED" ? "var(--warn)" : needs ? "var(--warn)" : "var(--accent)" }} />
                  {status}{metaText ? ` · ${metaText}` : ""}
                </div>
              </Link>
            );
          })}
        </section>

        {!selected ? null : (
          <article style={{ flex: "2 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>{threadTitle(analysis)}</h2>
                  <span className="meta-13">
                    {analysis ? `Ran ${analysis.createdAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${analysis.createdAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Queued"}
                    {" · "}{selected.channelName ? `#${selected.channelName}` : "channel name arrives on the next catch-up"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <a className="btn" href={slackPermalink(ws.name, selected.channelId, selected.threadTs)} target="_blank" rel="noreferrer">Open in Slack</a>
                </div>
              </div>

              {selected.analyses[0]?.status === "FAILED" && selected.analyses[0].error?.startsWith("no new messages") ? <p className="meta-13">Nothing new since the previous catch-up, {ago(selected.analyses[0].createdAt)} ago. The earlier analysis is below.</p> : null}
              {analysis?.status === "FAILED" && !analysis.error?.startsWith("no new messages") ? <div className="error-line">Analysis failed after {analysis.attempts} attempt{analysis.attempts === 1 ? "" : "s"}: {analysis.error}</div> : null}
              {analysis && analysis.status !== "DONE" && analysis.status !== "FAILED" ? <p className="meta-13">Analyzing… this page refreshes itself every few seconds.</p> : null}

              {analysis?.status === "DONE" ? (
                <>
                  <div className="divider-t" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 18, paddingTop: 18 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <h3 className="label">Summary</h3>
                      <p style={{ lineHeight: 1.55 }}>{analysis.summary}</p>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <h3 className="label">Decision</h3>
                      <p style={{ lineHeight: 1.55 }} className="text-2">{analysis.decision || "None yet."}</p>
                      <h3 className="label" style={{ marginTop: 10 }}>Next step</h3>
                      <p style={{ lineHeight: 1.55 }}>{analysis.nextStep || "None suggested."}</p>
                    </div>
                  </div>
                  <div className="divider-t" style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 18 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <h3 className="label">Open questions · {analysis.openQuestions.length}</h3>
                      {analysis.needResponse ? <span className="badge badge-warn">Needs response</span> : <span className="badge badge-ok">Caught up</span>}
                    </div>
                    {analysis.openQuestions.length === 0 ? <p className="meta-13">None.</p> : (
                      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, lineHeight: 1.45 }}>
                        {analysis.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
                      </ul>
                    )}
                  </div>
                  {/* "On you" (USER_FLOWS §3): the answer to "do I need to do anything?", pulled out of the full list. */}
                  <div className="divider-t" style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 18 }}>
                    <h3 className="label" style={{ marginBottom: 6 }}>On you · {analysis.actionItems.filter((i) => i.assigneeId === ctx.user.id).length}</h3>
                    {analysis.actionItems.filter((i) => i.assigneeId === ctx.user.id).length === 0 ? <p className="meta-13">Nothing on you in this thread.</p> : null}
                    {analysis.actionItems.filter((i) => i.assigneeId === ctx.user.id).map((i) => (
                      <ActionItemRow
                        key={`mine-${i.id}`}
                        users={users}
                        item={{ id: i.id, task: i.task, assigneeId: i.assigneeId, assigneeName: i.assigneeName, assignmentSource: i.assignmentSource, assigneeConfirmed: i.assigneeConfirmed }}
                      />
                    ))}
                  </div>
                  <div className="divider-t" style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 18 }}>
                    <h3 className="label" style={{ marginBottom: 6 }}>All action items · {analysis.actionItems.length}</h3>
                    {analysis.actionItems.length === 0 ? <p className="meta-13">No action items in this thread.</p> : null}
                    {analysis.actionItems.map((i) => (
                      <ActionItemRow
                        key={i.id}
                        users={users}
                        item={{ id: i.id, task: i.task, assigneeId: i.assigneeId, assigneeName: i.assigneeName, assignmentSource: i.assignmentSource, assigneeConfirmed: i.assigneeConfirmed }}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </div>

            {analysis?.status === "DONE" ? (
              <DraftsPanel
                channel={selected.channelName ?? selected.channelId}
                drafts={analysis.drafts.map((d): DraftView => ({
                  id: d.id, type: d.type, text: d.text, reason: d.reason, status: d.status, lastError: d.lastError,
                  postedAt: d.postedAt?.toISOString() ?? null,
                  permalink: d.slackMessageTs ? slackPermalink(ws.name, selected.channelId, d.slackMessageTs) : null,
                  notionPageUrl: d.notionPageUrl,
                  notionError: notionFailures.get(d.id) ?? null,
                }))}
              />
            ) : null}
          </article>
        )}
      </div>
    </Shell>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="card" style={{ padding: 40, textAlign: "center", display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600 }}>{title}</h2>
      <p className="meta-13" style={{ fontSize: 14 }}>{body}</p>
    </div>
  );
}
