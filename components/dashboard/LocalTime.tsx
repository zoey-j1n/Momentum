"use client";
// Renders a timestamp in the viewer's own time zone. Server components run in UTC on Vercel, so any
// toLocaleString() there shows UTC to everyone; this component formats in the browser instead.
// suppressHydrationWarning: the server's first paint (UTC) differs from the client's; React patches it.
export function LocalTime({ iso, options }: { iso: string; options?: Intl.DateTimeFormatOptions }) {
  const d = new Date(iso);
  return <time dateTime={iso} suppressHydrationWarning>{d.toLocaleString(undefined, options ?? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>;
}
