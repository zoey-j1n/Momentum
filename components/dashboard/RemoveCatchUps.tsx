"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { removeMyCatchUpsAction } from "@/app/dashboard/actions";

export function RemoveCatchUps({ threadId }: { threadId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  function go() {
    if (!window.confirm("Remove your catch-ups of this thread from the dashboard? Messages already posted to Slack stay. You can run Momentum on the thread again any time.")) return;
    start(async () => {
      const r = await removeMyCatchUpsAction(threadId);
      if (!r.ok) window.alert(r.error);
      else router.replace("/dashboard");
    });
  }
  return <button type="button" className="btn" disabled={pending} onClick={go} title="Delete your analyses of this thread">{pending ? "Removing…" : "Remove my catch-ups"}</button>;
}
