-- Split the sidebar's "unread result" marker out of `Session.status`.
--
-- Before this migration `status` conflated two orthogonal axes:
--   • lifecycle:  active (running) / idle (rested) / failed (errored)
--   • unread:     'done' was a magic value meaning "succeeded AND the
--                 user hasn't looked yet", and 'failed' implicitly
--                 doubled as "errored AND unread".
-- That conflation made the sidebar dot un-clearable in two cases:
-- a seen failure could never drop its red dot (nothing flipped it),
-- and a stale read could resurrect a 'done' the user had cleared.
--
-- New model: `status` is lifecycle-only and a dedicated `unread`
-- boolean drives the dot. The dot shows iff `unread`; its color comes
-- from `status` (idle=emerald, failed=red). `markSeen` now only flips
-- `unread`, leaving `status` intact.

-- 1. Add the column, defaulting existing rows to "seen".
ALTER TABLE "Session" ADD COLUMN "unread" BOOLEAN NOT NULL DEFAULT false;

-- 2. Preserve the CURRENTLY-VISIBLE dot state. Rows that were showing a
--    green ('done') or red ('failed') dot were, by definition, unread —
--    carry that forward so the dot survives the deploy and clears the
--    first time the user opens the session (the behavior this fix adds).
UPDATE "Session" SET "unread" = true WHERE "status" IN ('done', 'failed');

-- 3. Collapse the retired 'done' value into its lifecycle equivalent.
--    A successful, finished turn is lifecycle-`idle`; the unread-ness it
--    used to also encode now lives in the column set in step 2.
UPDATE "Session" SET "status" = 'idle' WHERE "status" = 'done';
