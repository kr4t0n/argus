-- One-shot repair for sessions left stuck at status='active'.
--
-- The result ingestor's live branch used to mark a session `active` for
-- ANY non-terminal chunk, including one that arrived after its own turn
-- had already finalized. Claude Code's bridge re-announces `system/init`
-- from a fire-and-forget async path that lands after the turn's `result`
-- (measured: after, every time), so the last thing the ingestor saw for
-- such a turn was non-terminal — and it wrote status='active',
-- unread=false over the correct terminal state.
--
-- Nothing ever put that right: only a LATER turn's final rewrites the
-- status, so a session whose MOST RECENT turn hit the race stayed
-- "running" forever. Observed in the wild stuck for over a month, with
-- the sidebar dot spinning, completion notifications suppressed, and
-- `queueDrainer` refusing to drain the session because it reads
-- status='active' as "mid-turn".
--
-- The code path is fixed (SessionService.setActiveForCommand), but the
-- rows already written need this.
--
-- The NOT EXISTS guard is what makes this safe to run at deploy time: a
-- session with a genuinely in-flight turn has a non-terminal Command and
-- is left alone. Only sessions claiming to be active with nothing
-- actually running are repaired.
--
-- `unread` is deliberately NOT touched. We cannot reconstruct whether the
-- user had seen the result, and asserting unread=true would light up dots
-- for turns they already read.
UPDATE "Session" s
   SET status = 'idle'
 WHERE s.status = 'active'
   AND NOT EXISTS (
     SELECT 1
       FROM "Command" c
      WHERE c."sessionId" = s.id
        AND c.status NOT IN ('completed', 'failed', 'cancelled')
   );
