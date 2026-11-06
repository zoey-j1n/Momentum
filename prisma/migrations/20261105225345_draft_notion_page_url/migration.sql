-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "notionPageUrl" TEXT;

-- AlterTable
ALTER TABLE "Job" ALTER COLUMN "runAt" SET DEFAULT now();
