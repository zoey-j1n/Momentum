// The two database guards the Slack ingress leans on (decision #14). The route itself is tested by
// hand against Slack; these prove the constraints it reports as "already queued" actually fire.
import { beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { prisma, resetDb } from "./db";

async function fixture() {
  const ws = await prisma.workspace.create({ data: { slackTeamId: "T_TEST", name: "Test" } });
  const user = await prisma.slackUser.create({ data: { workspaceId: ws.id, slackUserId: "U_TEST", displayName: "Tester" } });
  const thread = await prisma.thread.create({ data: { workspaceId: ws.id, channelId: "C_TEST", threadTs: "1700000000.000001" } });
  return { threadId: thread.id, userId: user.id };
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

describe("analysis dedupe constraints", () => {
  beforeEach(resetDb);

  it("allows only one PENDING or RUNNING analysis per thread", async () => {
    const { threadId, userId } = await fixture();
    await prisma.analysis.create({ data: { threadId, requestedById: userId, status: "PENDING" } });

    await expect(prisma.analysis.create({ data: { threadId, requestedById: userId, status: "PENDING" } })).rejects.toSatisfy(isUniqueViolation);
    await expect(prisma.analysis.create({ data: { threadId, requestedById: userId, status: "RUNNING" } })).rejects.toSatisfy(isUniqueViolation);
  });

  it("allows a new PENDING analysis once the previous one is DONE or FAILED", async () => {
    const { threadId, userId } = await fixture();
    const first = await prisma.analysis.create({ data: { threadId, requestedById: userId, status: "PENDING" } });
    await prisma.analysis.update({ where: { id: first.id }, data: { status: "DONE", throughTs: "1700000005.000001" } });

    const second = await prisma.analysis.create({ data: { threadId, requestedById: userId, status: "PENDING" } });
    expect(second.id).not.toBe(first.id);
  });

  it("still rejects two DONE analyses covering the same point, and ignores null throughTs", async () => {
    const { threadId, userId } = await fixture();
    await prisma.analysis.create({ data: { threadId, requestedById: userId, status: "DONE", throughTs: "1700000005.000001" } });
    await prisma.analysis.create({ data: { threadId, requestedById: userId, status: "FAILED" } }); // null throughTs, fine
    await prisma.analysis.create({ data: { threadId, requestedById: userId, status: "FAILED" } }); // second null, still fine

    await expect(
      prisma.analysis.create({ data: { threadId, requestedById: userId, status: "DONE", throughTs: "1700000005.000001" } }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  // Ten concurrent clicks, one winner. The same race the route will face.
  it("concurrent creates for one thread leave exactly one active analysis", async () => {
    const { threadId, userId } = await fixture();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => prisma.analysis.create({ data: { threadId, requestedById: userId, status: "PENDING" } })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && isUniqueViolation(r.reason))).toHaveLength(9);
    expect(await prisma.analysis.count({ where: { threadId } })).toBe(1);
  });
});
