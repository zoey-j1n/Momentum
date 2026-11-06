"use client";
// Re-fetches the server component's data on a timer while something is in flight (an analysis running,
// a draft posting, a Notion page being created). Nothing is polled when the page is at rest.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ active, everyMs = 5_000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs, router]);
  return null;
}
