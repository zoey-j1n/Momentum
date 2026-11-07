"use client";
// The Drafts card from Threads.dc.html: a tab per suggested draft (decision #19: only what the thread calls
// for), its reason, an editable textarea, Reject / Approve and post. No drafts is a good outcome, shown as such.
// State lives in the database; this component only holds the text being edited and the last result.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveAndSend, createNotionPageAction, rejectDraftAction, restoreDraftAction, saveDraftText, type ActionResult } from "@/app/dashboard/actions";

export type DraftView = {
  id: string;
  type: "REPLY" | "SUMMARY" | "MEETING" | "INVITE" | "NEXT_STEPS";
  text: string;
  reason: string | null;
  status: "SUGGESTED" | "APPROVED" | "REJECTED" | "POSTING" | "POSTED" | "FAILED";
  lastError: string | null;
  postedAt: string | null;
  permalink: string | null;
  notionPageUrl: string | null;
  notionState: "pending" | "failed" | null;
  notionError: string | null;
};

const TABS: { type: DraftView["type"]; label: string; hint: string; rows: number }[] = [
  { type: "REPLY", label: "Reply", hint: "Reply, in your voice", rows: 5 },
  { type: "SUMMARY", label: "Recap", hint: "Recap of what was discussed and concluded, for the thread or an email", rows: 9 },
  { type: "MEETING", label: "Meeting", hint: "Propose a sync", rows: 4 },
  { type: "INVITE", label: "Invite", hint: "Invite text: paste into the thread, an email, or a calendar event", rows: 6 },
  { type: "NEXT_STEPS", label: "Next steps", hint: "Built from the action items above. Momentum posts it and tags every owner shown there; change an owner before approving if it is wrong", rows: 7 },
];

export function DraftsPanel({ drafts, channel, notionEnabled }: { drafts: DraftView[]; channel: string; notionEnabled: boolean }) {
  const router = useRouter();
  const tabs = TABS.filter((t) => drafts.some((d) => d.type === t.type)); // only suggested kinds get a tab
  const [tab, setTab] = useState<DraftView["type"]>(tabs[0]?.type ?? "REPLY");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const draft = drafts.find((d) => d.type === tab);
  const meta = TABS.find((t) => t.type === tab)!;

  if (drafts.length === 0) {
    return (
      <section aria-labelledby="dr-h" className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 id="dr-h" style={{ fontSize: 16, fontWeight: 600 }}>Drafts</h2>
        <p style={{ lineHeight: 1.55 }}>Nothing for you to send. You&rsquo;re caught up.</p>
        <p className="meta-13">Momentum only drafts what the thread calls for: a reply when someone is waiting on you, a recap, or a meeting when people are trying to meet.</p>
      </section>
    );
  }

  function run(fn: () => Promise<ActionResult>) {
    setResult(null);
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <section aria-labelledby="dr-h" className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h2 id="dr-h" style={{ fontSize: 16, fontWeight: 600 }}>Drafts</h2>
        <div role="tablist" aria-label="Draft type" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)" }}>
          {tabs.map((t) => {
            const d = drafts.find((x) => x.type === t.type);
            return (
              <button key={t.type} type="button" role="tab" className="tab" aria-selected={tab === t.type} onClick={() => { setTab(t.type); setResult(null); }}>
                {t.label}{d && d.status !== "SUGGESTED" ? <span className="meta" style={{ marginLeft: 6 }}>{statusWord(d.status)}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {!draft ? (
        <p className="meta-13">No {meta.label.toLowerCase()} draft for this analysis.</p>
      ) : (
        <>
          <label htmlFor={`d-${draft.id}`} className="meta-13">{meta.hint} · #{channel}</label>
          {draft.reason ? <p style={{ fontSize: 13, lineHeight: 1.5, padding: "8px 12px", borderLeft: "3px solid var(--accent)", background: "var(--surface-2, transparent)" }}><span className="label" style={{ marginRight: 6 }}>Why</span>{draft.reason}</p> : null}
          <textarea
            id={`d-${draft.id}`}
            className="field"
            rows={meta.rows}
            value={edits[draft.id] ?? draft.text}
            onChange={(e) => setEdits({ ...edits, [draft.id]: e.target.value })}
            disabled={draft.status !== "SUGGESTED" || pending || draft.type === "NEXT_STEPS"}
          />
          {draft.type === "NEXT_STEPS" && draft.status === "SUGGESTED" ? <p className="meta-13">Edit the action items above to change this text: owner, Include, Done.</p> : null}
          {draft.type === "INVITE" && notionEnabled && !draft.notionPageUrl && draft.status === "SUGGESTED" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button type="button" className="btn btn-sm" disabled={pending || draft.notionState === "pending"} onClick={() => run(() => createNotionPageAction(draft.id))}>
                {draft.notionState === "pending" ? "Creating Notion page…" : "Create Notion page"}
              </button>
              <span className="meta">Adds the page link to this invite before it is posted.</span>
            </div>
          ) : null}
          {draft.notionPageUrl && draft.status !== "POSTED" ? <p className="meta-13">Notion page: <a href={draft.notionPageUrl} target="_blank" rel="noreferrer">open</a></p> : null}
          {draft.notionState === "failed" && draft.status !== "POSTED" ? <div className="error-line">Notion export failed: {draft.notionError}. Try again.</div> : null}
          <StatusLine draft={draft} />
          {result && !result.ok ? <div className="error-line">{result.error}</div> : null}
          {result && result.ok && result.message ? <div className="meta-13" style={{ color: "var(--ok-text)" }}>{result.message}</div> : null}
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span className="meta">Approving posts this exact text. Any edit needs a new approval.</span>
            <div style={{ display: "flex", gap: 8 }}>
              {draft.status === "SUGGESTED" ? (
                <>
                  <button type="button" className="btn btn-lg" disabled={pending} onClick={() => run(() => rejectDraftAction(draft.id))}>Reject</button>
                  {draft.type !== "NEXT_STEPS" && edits[draft.id] !== undefined && edits[draft.id] !== draft.text ? (
                    <button type="button" className="btn btn-lg" disabled={pending} onClick={() => run(() => saveDraftText(draft.id, edits[draft.id]))}>Save edit</button>
                  ) : null}
                  <button type="button" className="btn btn-lg btn-primary" disabled={pending} onClick={() => run(() => approveAndSend(draft.id, edits[draft.id] ?? draft.text))}>
                    {pending ? "Posting…" : "Approve and post"}
                  </button>
                </>
              ) : null}
              {draft.status === "APPROVED" || draft.status === "FAILED" ? (
                <button type="button" className="btn btn-lg btn-primary" disabled={pending} onClick={() => run(() => approveAndSend(draft.id, draft.text))}>
                  {pending ? "Posting…" : draft.status === "FAILED" ? "Retry post" : "Post"}
                </button>
              ) : null}
              {draft.status === "REJECTED" ? (
                <button type="button" className="btn btn-lg" disabled={pending} onClick={() => run(() => restoreDraftAction(draft.id))}>Restore</button>
              ) : null}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function statusWord(s: DraftView["status"]): string {
  return { SUGGESTED: "", APPROVED: "approved", REJECTED: "rejected", POSTING: "posting…", POSTED: "posted", FAILED: "failed" }[s];
}

function StatusLine({ draft }: { draft: DraftView }) {
  switch (draft.status) {
    case "SUGGESTED": return null;
    case "APPROVED": return <p className="meta-13">Approved, not posted yet.</p>;
    case "REJECTED": return <p className="meta-13">Rejected. Restore it to edit or approve.</p>;
    case "POSTING": return <p className="meta-13">Posting… If this stays for more than two minutes, the reconciler will settle it.</p>;
    case "POSTED": return (
      <p className="meta-13" style={{ color: "var(--ok-text)" }}>
        Posted{draft.postedAt ? ` ${new Date(draft.postedAt).toLocaleString()}` : ""}
        {draft.permalink ? <> · <a href={draft.permalink} target="_blank" rel="noreferrer">Open in Slack</a></> : null}
        {draft.type === "INVITE" ? (draft.notionPageUrl ? <> · <a href={draft.notionPageUrl} target="_blank" rel="noreferrer">Notion page</a></> : draft.notionState === "failed" ? <> · <span style={{ color: "var(--warn-text)" }}>Notion export failed: {draft.notionError}</span></> : draft.notionState === "pending" ? <> · Notion page: creating…</> : null) : null}
        . Final: posted messages are not edited from here.
      </p>
    );
    case "FAILED": return <div className="error-line">Post failed: {draft.lastError ?? "unknown error"}. Safe to retry.</div>;
  }
}
