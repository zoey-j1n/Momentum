// The only page a signed-out person can see. One button that starts the Slack OAuth flow.
import { redirect } from "next/navigation";
import { MomentumMark } from "@/components/dashboard/MomentumMark";
import { readSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await readSession()) redirect("/dashboard");
  const { error } = await searchParams;
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card" style={{ width: 380, maxWidth: "100%", padding: 28, display: "flex", flexDirection: "column", gap: 18, alignItems: "flex-start" }}>
        <MomentumMark />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>Sign in to Momentum</h1>
          <p className="meta-13" style={{ fontSize: 14 }}>
            Drafts you approve are posted to Slack under your own name, so Momentum needs your permission once.
          </p>
        </div>
        {error ? <p role="alert" style={{ fontSize: 13, color: "var(--danger, #b91c1c)" }}>{error}</p> : null}
        <a href="/api/slack/oauth/start" className="btn btn-primary" style={{ textDecoration: "none" }}>
          Sign in with Slack
        </a>
      </div>
    </main>
  );
}
