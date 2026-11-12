// The layout shell from DESIGN_SPEC.md: 232px sticky sidebar, main column. Server component.
import Link from "next/link";
import { MomentumMark } from "./MomentumMark";

type Props = {
  active: "overview" | "threads" | "drafts" | "items" | "channels";
  counts: { threads: number; drafts: number; items: number };
  user: { name: string; workspace: string };
  children: React.ReactNode;
};

// One page for now
const NAV = [
  { key: "threads", label: "Thread reviews", href: "/dashboard", count: "threads" },
] as const;

const ICONS: Record<string, string> = {
  overview: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  threads: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  drafts: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  items: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  channels: "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18",
};

export function Shell({ active, counts, user, children }: Props) {
  const initials = user.name.split(/[\s.]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexWrap: "wrap", alignItems: "stretch" }}>
      <aside style={{ flex: "1 1 232px", maxWidth: 232, background: "var(--surface)", borderRight: "1px solid var(--border)" }}>
        <div style={{ position: "sticky", top: 0, height: "100vh", minHeight: 560, padding: "24px 16px", display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 8px" }}>
            <MomentumMark />
            <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.01em" }}>Momentum</span>
          </div>
          <nav aria-label="Main" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {NAV.map((n) => {
              const count = "count" in n ? counts[n.count] : null;
              const inner = (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[n.key]} /></svg>
                  <span style={{ flex: 1 }}>{n.label}</span>
                  {count !== null && count > 0 ? <span className="mono meta">{count}</span> : null}
                  {"soon" in n && n.soon ? <span className="meta">soon</span> : null}
                </>
              );
              return "soon" in n && n.soon ? (
                <span key={n.key} className="nav-item" aria-disabled="true" title="Not built yet">{inner}</span>
              ) : (
                <Link key={n.key} href={n.href} className="nav-item" aria-current={active === n.key ? "page" : undefined}>{inner}</Link>
              );
            })}
          </nav>
          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 4px" }}>
              <span style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--ink)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600 }}>{initials}</span>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{user.name}</span>
                <span className="meta">{user.workspace}</span>
              </div>
              {/* POST so another site cannot sign you out with a link (decision #9). */}
              <form action="/api/auth/signout" method="post" style={{ marginLeft: "auto" }}>
                <button type="submit" className="btn btn-sm" title="Sign out">Sign out</button>
              </form>
            </div>
          </div>
        </div>
      </aside>
      <main style={{ flex: "999 1 560px", minWidth: 0, padding: "28px 32px 48px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>{children}</div>
      </main>
    </div>
  );
}
