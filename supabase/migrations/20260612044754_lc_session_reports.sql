-- Live Classroom: post-session reports + attendance + shared lecture summary.
-- See docs/designs/live-classroom/live-classroom-session-report.md.
--
-- 1. lc_rooms.lecture_summary — latest shared "summarize so far" snapshot,
--    { text, slidesCovered, generatedAt }. Lives on lc_rooms (deck_extraction
--    precedent): student-readable by design — it contains only slide text +
--    the professor's spoken words, which students already see/hear live.
--    lc_rooms is NOT in the realtime publication (migration 35), so updates
--    don't broadcast.
--
-- 2. lc_attendance — durable attendance capture (presence is realtime-only
--    and never persisted). One row per (room, student): joined_at on first
--    heartbeat, last_seen_at refreshed every ~60s by the student client.
--
-- 3. lc_session_reports — one computed report per ended room. Professor-only:
--    it contains non-responder/absent student names and struggle analytics,
--    which must never be student-readable (students CAN select lc_rooms rows,
--    which is why the report does not live there).
--
-- Tenant scoping: lc_* tables carry no institution_id; isolation flows
-- through room_id → lc_rooms → (prof_id | section enrollments), matching
-- every existing lc_ policy (migrations 30/34/36/61).

-- ── 1. Shared lecture summary cache ──────────────────────────────────

ALTER TABLE lc_rooms ADD COLUMN lecture_summary jsonb;

-- ── 2. Attendance ────────────────────────────────────────────────────

CREATE TABLE lc_attendance (
  room_id      uuid NOT NULL REFERENCES lc_rooms(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, student_id)
);

ALTER TABLE lc_attendance ENABLE ROW LEVEL SECURITY;

-- Professor of the room reads the full roster.
CREATE POLICY "prof reads attendance in own rooms"
  ON lc_attendance FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM lc_rooms r
    WHERE r.id = lc_attendance.room_id AND r.prof_id = auth.uid()
  ));

-- Students read only their own attendance rows.
CREATE POLICY "students read own attendance"
  ON lc_attendance FOR SELECT TO authenticated
  USING (student_id = auth.uid());

-- Writes happen via the service role only (markAttendance verifies
-- enrollment server-side first) — no INSERT/UPDATE policies on purpose.

-- ── 3. Session reports ───────────────────────────────────────────────

CREATE TABLE lc_session_reports (
  room_id      uuid PRIMARY KEY REFERENCES lc_rooms(id) ON DELETE CASCADE,
  report       jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lc_session_reports ENABLE ROW LEVEL SECURITY;

-- Professor-only: absent/non-responder names + struggle analytics.
CREATE POLICY "prof reads own session reports"
  ON lc_session_reports FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM lc_rooms r
    WHERE r.id = lc_session_reports.room_id AND r.prof_id = auth.uid()
  ));

-- Writes happen via the service role only — no INSERT/UPDATE policies.
