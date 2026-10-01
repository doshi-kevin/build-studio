-- Snapshot the UNCAPPED mastery estimate alongside the displayed score.
--
-- The displayed score is slew-rate limited: no single graded event may move it
-- more than MAX_EVENT_DELTA points. That protects a student from one bad day,
-- but it makes the displayed number a poor basis for a TREND indicator. A big
-- genuine jump is held back, then catches up over the following events, so a
-- professor reading week-over-week deltas sees a second gain that never
-- happened — the learning is real but gets attributed to the wrong week.
--
-- `state.t` is the uncapped pooled estimate the score converges toward. Trends
-- read it; the headline number keeps reading `score`. Nullable: rows written
-- before the engine recorded `t` have none, and the trend helpers fall back to
-- `score` for those.
--
-- No new RLS policy: the column lands on a table whose SELECT policies already
-- scope reads to the owning professor, that section's TAs, and the student
-- themselves. Writes still come only from the nightly job.
ALTER TABLE skill_mastery_snapshots
  ADD COLUMN IF NOT EXISTS estimate numeric
  CONSTRAINT skill_mastery_snapshots_estimate_range
  CHECK (estimate IS NULL OR (estimate >= 0 AND estimate <= 100));

-- Re-register the nightly job so it also copies the estimate.
--
-- Unschedule first. pg_cron's uniqueness is on (jobname, username), so a bare
-- cron.schedule replaces in place only when this migration is applied by the same
-- role that created the job in 20260724011154. Applied by a different role it
-- would leave TWO jobs named skill_mastery_snapshot; the old one still runs, and
-- ON CONFLICT DO NOTHING means whichever fires first wins, so `estimate` would
-- silently stay NULL on those days. Same idiom as
-- 20260808033043_guard_scheduled_quiz_publish_on_questions.sql.
DO $unschedule$
BEGIN
  PERFORM cron.unschedule('skill_mastery_snapshot');
EXCEPTION WHEN OTHERS THEN
  -- No such job (fresh database, or a differently-named predecessor). Fine.
  NULL;
END
$unschedule$;

SELECT cron.schedule(
  'skill_mastery_snapshot',
  '0 5 * * *',  -- 05:00 UTC daily, unchanged
  $$
    INSERT INTO skill_mastery_snapshots (student_id, skill_id, section_id, institution_id, score, estimate, captured_on)
    -- Defensive cast: `state` is free-form jsonb with nothing constraining it, and
    -- a single non-numeric or out-of-range 't' in ONE institution would raise and
    -- abort this INSERT ... SELECT for every tenant, silently stopping history
    -- accrual platform-wide. Today's engine always writes a clamped number; this
    -- is about the blast radius if that ever stops being true.
    SELECT student_id, skill_id, section_id, institution_id, score,
           CASE
             WHEN state->>'t' ~ '^-?[0-9]+(\.[0-9]+)?$'
               THEN LEAST(100, GREATEST(0, (state->>'t')::numeric))
           END,
           current_date
      FROM skill_mastery
     WHERE score IS NOT NULL
    ON CONFLICT (student_id, skill_id, captured_on) DO NOTHING;
  $$
);
