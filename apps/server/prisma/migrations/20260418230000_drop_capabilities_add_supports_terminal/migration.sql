-- Replace the free-form Agent.capabilities tag array with a dedicated
-- supportsTerminal boolean. The only capability we actually gated on was
-- "terminal"; the rest were purely informational pills in the context
-- pane, which has been removed. Existing rows that had "terminal" in
-- their capabilities array get supportsTerminal=true; everyone else
-- gets the default (false).

ALTER TABLE "Agent"
  ADD COLUMN "supportsTerminal" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Agent"
SET "supportsTerminal" = true
WHERE "capabilities" @> '["terminal"]'::jsonb;

ALTER TABLE "Agent" DROP COLUMN "capabilities";
