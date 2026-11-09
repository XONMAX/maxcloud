-- Indexes Prisma's schema language cannot express.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One live item per name per folder (case-insensitive). NULL parent = root, so coalesce.
CREATE UNIQUE INDEX "Node_live_name_unique"
  ON "Node" ("ownerId", COALESCE("parentId", ''), lower("name"))
  WHERE "deletedAt" IS NULL;

-- Folder listing: keyset over (type, name, id) for live children of a folder.
CREATE INDEX "Node_list_children" ON "Node" ("parentId", "type", "name", "id") WHERE "deletedAt" IS NULL;
-- Root listing per owner.
CREATE INDEX "Node_list_root" ON "Node" ("ownerId", "type", "name", "id") WHERE "deletedAt" IS NULL AND "parentId" IS NULL;
-- Trash listing.
CREATE INDEX "Node_trash_roots" ON "Node" ("ownerId", "deletedAt") WHERE "trashRoot" = true;
-- Name search.
CREATE INDEX "Node_name_trgm" ON "Node" USING gin (lower("name") gin_trgm_ops) WHERE "deletedAt" IS NULL;

-- Quota invariants: the database refuses negative counters (catches accounting bugs loudly).
ALTER TABLE "User" ADD CONSTRAINT "User_used_nonneg" CHECK ("usedBytes" >= 0);
ALTER TABLE "User" ADD CONSTRAINT "User_reserved_nonneg" CHECK ("reservedBytes" >= 0);
