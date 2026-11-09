-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "hasThumbnail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "versionCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Node_ownerId_sha256_idx" ON "Node"("ownerId", "sha256");
