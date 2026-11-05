// The ingress without Slack: catchUp() against the test database, and the route's gate (401 before any DB work).
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDb } from "./db";
import { catchUp, type MessageActionPayload } from "../lib/slack/ingress";
import { POST } from "../app/api/slack/interactions/route";

const payload = (over: Partial<MessageActionPayload["message"]> = {}): MessageActionPayload => ({
  type: "message_action",
  callback_id: "catch_up",
  team: { id: "T_TEST", domain: "test" },
  channel: { id: "C_TEST" },
  user: { id: "U_TEST", username: "tester" },
  message: { ts: "1700000005.000001", thread_ts: "1700000000.000001", ...over },
  response_url: "https://hooks.slack.com/app/T_TEST/x/y",
});

describe("catchUp", () => {
  beforeEach(resetDb);

  it("first click: creates workspace, requester, thread, a PENDING analysis with no throughTs, and a job", async () => {
    const r = await catchUp(payload());
    expect(r.kind).toBe("queued");
    if (r.kind !== "queued") return;

    const analysis = await prisma.analysis.findUniqueOrThrow({ where: { id: r.analysisId } });
    expect(analysis).toMatchObject({ status: "PENDING", throughTs: null, threadId: r.threadId });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: r.threadId } });
    expect(thread).toMatchObject({ channelId: "C_TEST", threadTs: "1700000000.000001" });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: r.jobId } })).toMatchObject({ type: "analyze", status: "QUEUED", payload: { analysisId: r.analysisId } });
  });

  it("clicking the parent message uses its own ts as the thread", async () => {
    const r = await catchUp(payload({ ts: "1700000000.000001", thread_ts: undefined }));
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: r.threadId } });
    expect(thread.threadTs).toBe("1700000000.000001");
  });

  // Done-when: clicking the shortcut twice quickly creates one analysis.
  it("double click: ten concurrent requests, one analysis, one job, nine 'already_queued'", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => catchUp(payload())));
    expect(results.filter((r) => r.kind === "queued")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "already_queued")).toHaveLength(9);
    expect(await prisma.analysis.count()).toBe(1);
    expect(await prisma.job.count()).toBe(1);
    expect(await prisma.thread.count()).toBe(1);
  });

  it("a click on a message the last analysis already covered is 'caught_up' and creates nothing", async () => {
    const first = await catchUp(payload());
    if (first.kind !== "queued") throw new Error("setup");
    // Pretend the worker finished: cursor moved to the clicked message.
    await prisma.analysis.update({ where: { id: first.analysisId }, data: { status: "DONE", throughTs: "1700000005.000001" } });
    await prisma.thread.update({ where: { id: first.threadId }, data: { lastAnalyzedTs: "1700000005.000001" } });

    expect((await catchUp(payload())).kind).toBe("caught_up");
    expect((await catchUp(payload({ ts: "1700000003.000001" }))).kind).toBe("caught_up");
    expect(await prisma.analysis.count()).toBe(1);

    // A newer message is new work.
    expect((await catchUp(payload({ ts: "1700000009.000001" }))).kind).toBe("queued");
    expect(await prisma.analysis.count()).toBe(2);
  });
});

describe("POST /api/slack/interactions", () => {
  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
  });

  const body = "payload=" + encodeURIComponent(JSON.stringify(payload()));
  const request = (sig: string, ts = String(Math.floor(Date.now() / 1000))) =>
    new Request("http://localhost/api/slack/interactions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
      body,
    });

  // Done-when: a request with a wrong signature gets 401.
  it("rejects a wrong signature with 401 before touching the database", async () => {
    await resetDb();
    const res = await POST(request("v0=" + "0".repeat(64)));
    expect(res.status).toBe(401);
    expect(await prisma.thread.count()).toBe(0);
  });

  it("rejects a valid signature that is 10 minutes old", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const sig = "v0=" + createHmac("sha256", "test-signing-secret").update(`v0:${ts}:${body}`).digest("hex");
    expect((await POST(request(sig, ts))).status).toBe(401);
  });
});
