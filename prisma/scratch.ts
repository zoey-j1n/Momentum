// Scratch runner for trying queries against the seeded local DB.
// Put a query in main(), then: npx tsx prisma/scratch.ts
import "dotenv/config";
import { prisma } from "../lib/db";

async function main() {
  // Exercise 1
  const user = await prisma.slackUser.findFirst({ where: { displayName: "Khoa" } });
  if (!user) throw new Error("No user named Khoa. Run the seed first.");
  const actionItems = await prisma.actionItem.findMany({ 
    where: { 
      done: false,
      assigneeId: user.id,
      analysis: { thread: {workspaceId: user.workspaceId } }
    }, 
    orderBy: {analysis: { createdAt: "desc" }}, 
    include: { analysis: {include: {thread: true}}},
    take: 10 
  });

  // Exercise 2: the restore transition (REJECTED -> SUGGESTED) with its audit event in one transaction.
  // A transition is a conditional update plus an audit row, written together.

  // 1. Pin one draft deterministically (findFirst without orderBy is arbitrary), with the path to its workspaceId.
  const draft = await prisma.draft.findFirst({
    where: { type: "REPLY" },
    include: { analysis: { include: { thread: true } } },
  });
  if (!draft) throw new Error("No REPLY draft found. Run the seed first.");
  const workspaceId = draft.analysis.thread.workspaceId;

  // 2. Setup only: put it in REJECTED so there is something to restore.
  //    Run with `--reject` the first time, without it the second time.
  if (process.argv.includes("--reject")) {
    await prisma.draft.update({ where: { id: draft.id }, data: { status: "REJECTED" } });
  }

  // 3. The transition. `where` names the status we expect right now; `count` tells us whether it was true.
  const restored = await prisma.$transaction(async (tx) => {
    const { count } = await tx.draft.updateMany({
      where: { id: draft.id, status: "REJECTED" },
      data: { status: "SUGGESTED" },
    });
    if (count !== 1) return false; // not REJECTED: nothing changed, so no audit event
    await tx.auditEvent.create({
      data: {
        workspaceId,
        actorId: user.id,
        entityType: "Draft",
        entityId: draft.id,
        action: "restore",
        fromStatus: "REJECTED",
        toStatus: "SUGGESTED",
      },
    });
    return true;
  });

  // The SQL line that enforces "one REPLY per analysis"
  

  console.log("restored:", restored);
  console.log(await prisma.draft.findUnique({ where: { id: draft.id }, select: { id: true, status: true } }));
  console.log(await prisma.auditEvent.findMany({ where: { entityId: draft.id } }));

}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());


/**
 * SCRATCH WORK: 
 * all action items assigned to me that aren't done so status != "done" and assigneeId = my slack user id
 * newest first and with the threads channel: 
 * sort
 */
