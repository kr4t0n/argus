-- Model picker: persist the session-default model choice and record
-- what each turn was actually dispatched with.
--
-- "Session"."modelSelection" holds a ModelSelection JSON object
-- ({model, effort, context, speed} — see shared-types/protocol.ts).
-- NULL means "CLI default": no model flags are passed to the wrapped
-- CLI, which is byte-for-byte the pre-feature behavior. It is merged
-- into every turn's Command options at dispatch; a per-turn override
-- from the composer wins key-by-key.
--
-- "Command"."options" snapshots the merged adapter options the turn
-- was dispatched with. Before this, options rode the Redis wire
-- message transiently and were lost — history couldn't answer "which
-- model ran this turn?". NULL for pre-feature rows and turns with no
-- options.
ALTER TABLE "Session" ADD COLUMN "modelSelection" JSONB;
ALTER TABLE "Command" ADD COLUMN "options" JSONB;
