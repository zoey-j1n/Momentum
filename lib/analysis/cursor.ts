// The per-requester cursor (decision #19). "What has this person already caught up on?" is the newest
// message covered by their latest finished analysis of the thread. Null means they never have, so the
// worker reads the whole thread. Derived, not stored: there is nothing to keep in sync.
import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../db";

export async function requesterCursor(threadId: string, requestedById: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string | null> {
  const latest = await db.analysis.findFirst({
    where: { threadId, requestedById, status: "DONE", throughTs: { not: null } },
    orderBy: { throughTs: "desc" }, // fixed-width Slack ts strings sort as time (decision #2)
    select: { throughTs: true },
  });
  return latest?.throughTs ?? null;
}
