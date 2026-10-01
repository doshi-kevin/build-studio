-- Live Classroom "Class Insights": adds an explicit generation status to the
-- professor report and a separate PII-free student-facing insights blob.
-- See docs/designs/live-classroom/live-classroom-class-insights-design.md.
--
-- Why a SEPARATE student table (not a column on lc_session_reports): RLS is
-- row-level, so the professor blob (which contains absent/non-responder names
-- and struggle analytics) and the student-safe blob must live in different
-- rows to be isolated by policy. The two blobs also have different lifecycles
-- — the professor stats are deterministic/fast, the student study materials
-- need slow, best-effort LLM generation — so separate rows let us write the
-- fast one immediately and patch the slow one in later.
--
-- Tenant scoping: lc_* tables carry no institution_id; isolation flows through
-- room_id -> lc_rooms -> (prof_id | section enrollments), matching every
-- existing lc_ policy (migrations 30/34/36/61, lc_session_reports in 72).

-- ── 1. Explicit generation status on the professor report ────────────
-- Today an in-flight report is modelled by a `{status:'generating'}` JSON
-- placeholder inside `report`. Add first-class columns so the generation
-- orchestrator can mark generating | ready | failed without overloading the
-- payload. Existing rows are finished reports, hence default 'ready'.

ALTER TABLE lc_session_reports
  ADD COLUMN status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('generating', 'ready', 'failed')),
  ADD COLUMN generation_started_at timestamptz;

-- ── 2. PII-free student-facing insights ──────────────────────────────
-- One row per ended room. `content` holds ONLY non-identifying data: lecture
-- summary, per-quiz questions + correct answers + explanations + class-level
-- accuracy (suppressed when < 5 answered), concept stats, flashcards, and the
-- reveal-based practice quiz. Never names, absentees, or who-answered-what —
-- per-student numbers are computed live from the caller's OWN responses.

CREATE TABLE lc_class_insights_student (
  room_id      uuid PRIMARY KEY REFERENCES lc_rooms(id) ON DELETE CASCADE,
  content      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'ready', 'failed')),
  generated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lc_class_insights_student ENABLE ROW LEVEL SECURITY;

-- Readable by the room's professor OR an enrolled student of the room's
-- section. Mirrors the enrollment predicate used by lc_attendance /
-- lecture-summary access. The blob is PII-free by construction, so this is a
-- safe student read; identity-specific numbers never live here.
CREATE POLICY "prof or enrolled student reads class insights"
  ON lc_class_insights_student FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      WHERE r.id = lc_class_insights_student.room_id
        AND (
          r.prof_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM enrollments e
            WHERE e.section_id = r.section_id
              AND e.student_id = auth.uid()
              AND e.status IN ('enrolled', 'completed')
          )
        )
    )
  );

-- Writes happen via the service role only (the generation orchestrator
-- verifies ownership/enrollment server-side first) — no INSERT/UPDATE policy
-- on purpose, matching lc_session_reports and lc_attendance.
