-- AlterTable
ALTER TABLE "Analysis" ALTER COLUMN "throughTs" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Job" ALTER COLUMN "runAt" SET DEFAULT now();

-- Decision #14: at most one analysis in flight per thread. A second shortcut click while the first
-- is PENDING or RUNNING violates this and the ingress reports "already queued". Partial indexes are
-- not expressible in schema.prisma, so this line is maintained by hand.
CREATE UNIQUE INDEX "Analysis_one_active_per_thread" ON "Analysis"("threadId") WHERE "status" IN ('PENDING', 'RUNNING');
