-- Free-form rules text the user wants every CLI agent they spawn
-- to follow. Edited from the dashboard's user panel and (in a
-- follow-up) injected into adapters at agent boot. Nullable so
-- existing rows have a clean "no rules set" state distinct from
-- an empty string.
ALTER TABLE "User" ADD COLUMN "rules" TEXT;
