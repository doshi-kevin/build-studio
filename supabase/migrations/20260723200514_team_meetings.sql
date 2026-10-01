-- ============================================================
-- Migration: Team Meeting Hub (coordination layer)
--
-- Scholera hosts nothing: students use their own Google Meet + own
-- Fathom. These tables are a lightweight coordination layer for a
-- project team — a reusable Meet link, a log of meetings with notes
-- links, and a group-availability grid. We store only URLs students
-- choose to share (no recordings, no transcripts, no credentials).
--
-- Students-only surface, like project_chat_* — RLS gated by
-- is_team_member(team_id, auth.uid()); no professor access. SELECT-only
-- for the client (realtime reads); ALL writes go through the
-- service-role admin client in server actions. Tenant isolation is
-- transitive through team membership (matching the project_* family;
-- no institution_id column).
-- ============================================================

-- ── 1. Reusable team meeting room — one link per team ────────────
CREATE TABLE public.team_meeting_rooms (
  team_id     UUID PRIMARY KEY REFERENCES public.project_teams(id) ON DELETE CASCADE,
  meet_url    TEXT NOT NULL,
  updated_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.team_meeting_rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Team members can read the meeting room"
  ON public.team_meeting_rooms FOR SELECT
  USING (public.is_team_member(team_id, (select auth.uid())));

-- ── 2. Meetings — logged / scheduled sessions with notes links ───
CREATE TABLE public.team_meetings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES public.project_teams(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  section_id      UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title           TEXT NOT NULL DEFAULT 'Team meeting',
  scheduled_start TIMESTAMPTZ,
  -- Per-session join link; when null the team's reusable room link is used.
  meet_url        TEXT,
  -- A notes link the student pastes (their Fathom share URL or a Google Doc).
  -- We store only the URL — never a recording or transcript.
  notes_url       TEXT,
  notes_label     TEXT,
  -- Reminder idempotency guard: the sweep only reminds rows where this is
  -- null, then stamps it, so a stuttering/overlapping cron can't double-send.
  reminded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX team_meetings_team_id_idx ON public.team_meetings (team_id);
-- Reminder sweep hot path: upcoming, not-yet-reminded, scheduled meetings.
CREATE INDEX team_meetings_reminder_due_idx
  ON public.team_meetings (scheduled_start)
  WHERE reminded_at IS NULL AND scheduled_start IS NOT NULL;

ALTER TABLE public.team_meetings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Team members can read meetings"
  ON public.team_meetings FOR SELECT
  USING (public.is_team_member(team_id, (select auth.uid())));

-- ── 3. Availability — each member's free 30-min slots (when2meet) ─
CREATE TABLE public.team_availability (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES public.project_teams(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Slot start, stored as UTC; the grid renders in the viewer's local tz.
  slot_start  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id, slot_start)
);

CREATE INDEX team_availability_team_id_idx ON public.team_availability (team_id);

ALTER TABLE public.team_availability ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Team members can read availability"
  ON public.team_availability FOR SELECT
  USING (public.is_team_member(team_id, (select auth.uid())));

-- ── Realtime — panels subscribe for live updates ─────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.team_meeting_rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE public.team_meetings;
ALTER PUBLICATION supabase_realtime ADD TABLE public.team_availability;
