-- Decision #21: a Next steps post built from the action items and posted by the Momentum bot.

-- AlterEnum
ALTER TYPE "DraftType" ADD VALUE 'NEXT_STEPS';

-- AlterTable: which items go into the post, and which post announced them.
ALTER TABLE "ActionItem" ADD COLUMN     "announcedInDraftId" TEXT,
ADD COLUMN     "include" BOOLEAN NOT NULL DEFAULT true;
