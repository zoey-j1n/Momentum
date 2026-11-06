-- Decision #19: an analysis is one person's catch-up on a thread, not the thread's.

-- DropIndex: the old "same thread, same point" rule, now per requester below.
DROP INDEX "Analysis_threadId_throughTs_key";

-- AlterTable: why a draft was suggested (shown on the dashboard).
ALTER TABLE "Draft" ADD COLUMN     "reason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Analysis_threadId_requestedById_throughTs_key" ON "Analysis"("threadId", "requestedById", "throughTs");

-- One in-flight analysis per (thread, requester), replacing the per-thread partial index from decision #14.
-- Two people may catch up on the same thread at once; one person may not queue it twice.
DROP INDEX IF EXISTS "Analysis_one_active_per_thread";
CREATE UNIQUE INDEX "Analysis_one_active_per_requester" ON "Analysis"("threadId", "requestedById") WHERE "status" IN ('PENDING', 'RUNNING');
