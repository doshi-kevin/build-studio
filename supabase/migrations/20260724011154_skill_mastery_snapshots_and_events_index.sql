-- Slice 3 of the roadmap triage engine — the two structural gaps.
--
-- (A) skill_mastery_snapshots: a daily history of skill_mastery scores so the
--     engine can show trend deltas ("mastery slipping 64% → 52%", "35% → 78%").
--     skill_mastery itself keeps only the current score; this accrues history.
-- (B) a composite index on events for the consumption-signal aggregates
--     (open-counts, "you are here", "new since last visit") that filter by
--     section_id + event_type over a time window.

-- ── (A) mastery-history snapshot table ───────────────────────────
CREATE TABLE IF NOT EXISTS skill_mastery_snapshots (
  student_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  skill_id       uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  section_id     uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  score          numeric CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  captured_on    date NOT NULL DEFAULT current_date,
  PRIMARY KEY (student_id, skill_id, captured_on)  -- one row per student·skill·day (idempotent nightly insert)
);
CREATE INDEX IF NOT EXISTS idx_skill_mastery_snapshots_section ON skill_mastery_snapshots(section_id, captured_on);

ALTER TABLE skill_mastery_snapshots ENABLE ROW LEVEL SECURITY;

-- Read policies MIRROR skill_mastery's post-#330-hardening SELECT policies
-- exactly (professor/TA read section, student read own). SELECT-only: writes
-- come solely from the nightly cron job below (runs as table owner, bypassing
-- RLS) — never a FOR ALL policy, which was the #330 vulnerability that let a
-- professor overwrite engine-computed scores via a direct PostgREST call.
CREATE POLICY "Professors and TAs read section mastery snapshots"
  ON skill_mastery_snapshots FOR SELECT
  USING (
    section_id IN (SELECT id FROM course_sections WHERE professor_id = (SELECT auth.uid()))
    OR section_id IN (
      SELECT section_id FROM section_staff
      WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now() AND role = 'ta'
    )
  );

CREATE POLICY "Students read their own mastery snapshots"
  ON skill_mastery_snapshots FOR SELECT
  USING (student_id = (SELECT auth.uid()));

-- Nightly snapshot: copy the current non-null skill_mastery scores into today's
-- row. ON CONFLICT DO NOTHING keeps it idempotent if the job runs twice in a day.
-- pg_cron is already installed (00000000000034); jobs here run pure in-DB SQL.
SELECT cron.schedule(
  'skill_mastery_snapshot',
  '0 5 * * *',  -- 05:00 UTC daily
  $$
    INSERT INTO skill_mastery_snapshots (student_id, skill_id, section_id, institution_id, score, captured_on)
    SELECT student_id, skill_id, section_id, institution_id, score, current_date
      FROM skill_mastery
     WHERE score IS NOT NULL
    ON CONFLICT (student_id, skill_id, captured_on) DO NOTHING;
  $$
);

-- ── (B) events aggregate index ───────────────────────────────────
-- The consumption signals filter events by (section_id, event_type) over a
-- recent window; the existing single-column indexes are weak for that combo.
CREATE INDEX IF NOT EXISTS idx_events_section_type_time ON events(section_id, event_type, timestamp);
