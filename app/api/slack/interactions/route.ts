// Slack's doorbell. Slack POSTs here when someone runs the "Catch up with Momentum" message shortcut.
// Budget: 3,000 ms to return 200 or the user sees an error. The model takes ~9 s, so nothing slow
// happens here; the work goes on the queue (decision #8) and the worker does it.
import { after } from "next/server";
import { kickRunner } from "@/lib/jobs/kick";
import { verifySlackRequest } from "@/lib/slack/verify";
import { ackText, catchUp, MessageActionPayload } from "@/lib/slack/ingress";

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();

  // 1. Raw body first. The signature covers these exact bytes; parsing before this would risk changing them.
  const rawBody = await req.text();

  // 2. Is this really Slack? HMAC over timestamp + raw body, constant-time compare, 5-minute replay window.
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return new Response("server misconfigured: SLACK_SIGNING_SECRET is not set", { status: 500 });
  if (!verifySlackRequest(rawBody, req.headers, secret)) {
    return new Response("invalid signature", { status: 401 });
  }

  // 3. Now parse. The body is a form with one field, `payload`, whose value is JSON text.
  const payloadText = new URLSearchParams(rawBody).get("payload");
  if (!payloadText) return new Response("missing payload", { status: 400 });
  let json: unknown;
  try {
    json = JSON.parse(payloadText);
  } catch {
    return new Response("payload is not JSON", { status: 400 });
  }
  const parsed = MessageActionPayload.safeParse(json);
  if (!parsed.success) return new Response(`unexpected payload: ${parsed.error.message}`, { status: 400 });
  const payload = parsed.data;

  // 4. Record the request: thread row, PENDING analysis, queued job. Or "already queued" / "caught up".
  const result = await catchUp(payload);

  // 5. Acknowledge the person who clicked, after the response below has gone out. after() runs the
  //    callback once the response is sent, so the 3-second clock is not waiting on Slack's webhook.
  const dashboardUrl = `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/dashboard`;
  after(async () => {
    const res = await fetch(payload.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text: ackText(result, dashboardUrl) }),
    });
    if (!res.ok) console.warn(`[slack ingress] ack failed: ${res.status} ${await res.text()}`);
  });
  //    And wake the job runner so the analysis starts now, not at the next cron tick (decision #9).
  //    No-op locally, where `npm run worker` is polling.
  if (result.kind === "queued") after(() => kickRunner(new URL(req.url).origin));

  // 6. Done-when: this number stays well under 3,000.
  console.log(`[slack ingress] ${result.kind} thread=${result.threadId} in ${Date.now() - started}ms`);
  return new Response(null, { status: 200 });
}
