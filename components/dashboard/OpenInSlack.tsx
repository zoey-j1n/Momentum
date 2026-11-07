"use client";
// "Open in Slack" as a real button: tries the desktop app first (slack:// deep link), and if nothing
// takes the hand-off within a second, opens the web permalink instead.
export function OpenInSlack({ teamId, channelId, ts, webUrl }: { teamId: string; channelId: string; ts: string; webUrl: string }) {
  function open() {
    const deepLink = `slack://channel?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(channelId)}&message=${encodeURIComponent(ts)}`;
    const started = Date.now();
    const fallback = window.setTimeout(() => {
      // If the app opened, the page lost focus and the timer fired late; if not, fall back to the browser.
      if (Date.now() - started < 1500) window.open(webUrl, "_blank", "noopener");
    }, 900);
    window.addEventListener("blur", () => window.clearTimeout(fallback), { once: true });
    window.location.href = deepLink;
  }
  return (
    <button type="button" className="btn btn-primary" onClick={open} title="Opens the Slack app, or the web version if the app is not installed">
      Open in Slack
    </button>
  );
}
