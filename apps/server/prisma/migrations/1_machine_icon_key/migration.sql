-- Per-machine user-chosen icon glyph (one of MachineIcon's CATALOG
-- keys, e.g. "server-cog"). Nullable: existing rows fall back to the
-- frontend's default ("server") and the dashboard treats null + missing
-- key identically.
ALTER TABLE "Machine" ADD COLUMN "iconKey" TEXT;
