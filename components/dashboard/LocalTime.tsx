"use client";
// Renders a timestamp in the viewer's own time zone.
//
// Server components run in UTC on Vercel, so any toLocaleString() there shows UTC to everyone. This client
// component is still rendered once on the server (SSR), and suppressHydrationWarning alone does NOT fix it:
// React keeps the server's text and only silences the mismatch warning. So the local string is produced in an
// effect, which runs only in the browser, after hydration. Until then the UTC text is shown with a "UTC" tag.
import { useEffect, useState } from "react";

const DEFAULT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

export function LocalTime({ iso, options }: { iso: string; options?: Intl.DateTimeFormatOptions }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(new Date(iso).toLocaleString(undefined, options ?? DEFAULT));
  }, [iso, options]);
  const fallback = `${new Date(iso).toLocaleString("en-US", { ...(options ?? DEFAULT), timeZone: "UTC" })} UTC`;
  return <time dateTime={iso}>{text ?? fallback}</time>;
}
