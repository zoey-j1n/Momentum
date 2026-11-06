-- AlterTable
ALTER TABLE "Job" ALTER COLUMN "runAt" SET DEFAULT now();

-- AlterTable
ALTER TABLE "SlackUser" ADD COLUMN     "userTokenEnc" TEXT,
ADD COLUMN     "userTokenUpdatedAt" TIMESTAMP(3);
