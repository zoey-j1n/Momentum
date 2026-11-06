-- AlterTable
ALTER TABLE "Job" ALTER COLUMN "runAt" SET DEFAULT now();

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "channelName" TEXT;
