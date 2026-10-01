-- Scope three over-permissive SELECT policies that returned rows to anyone
-- (anon + every authenticated user, across all tenants) via the browser-
-- reachable publishable key. (Security review 2026-06-11, Vulns 19 & 20.)
--
--   1. blocked_times      — "Students can view blocked times for slot generation"
--                           was FOR SELECT USING (true): every professor's
--                           schedule + free-text notes leaked to all tenants.
--   2/3. *_message_reactions — "Anyone can read reactions in their channels"
--                           was FOR SELECT USING (true): every reaction row
--                           (message_id, user_id, emoji) leaked cross-tenant.
--                           Their INSERT WITH CHECK only checked user_id, so a
--                           user could also write a reaction onto ANY message
--                           directly via PostgREST — tightened here too.
--
-- Reads of these tables that the app relies on all go through either the
-- service-role client (bypasses RLS) or an RLS-enforced path that the scoped
-- policies below still satisfy (the student office-hours page reads a
-- professor's blocked_times via the anon client — preserved by the enrollment
-- predicate).

BEGIN;

-- ── 1. blocked_times ───────────────────────────────────────────────────────
-- Professors already have full access via the existing "... FOR ALL" policy.
-- Replace the USING(true) student-read policy with one scoped to students
-- enrolled in one of that professor's sections (the office-hours slot-
-- generation use case), so a student only sees the availability of professors
-- they actually take a course with.
DROP POLICY IF EXISTS "Students can view blocked times for slot generation" ON public.blocked_times;
CREATE POLICY "Students can view blocked times for slot generation"
  ON public.blocked_times
  FOR SELECT
  TO authenticated
  USING (
    professor_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.course_sections cs
      JOIN public.enrollments e ON e.section_id = cs.id
      WHERE cs.professor_id = blocked_times.professor_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );

-- ── 2. discussion_message_reactions ────────────────────────────────────────
-- A reaction is visible / writable iff the caller can access the message's
-- channel — mirrors the discussion_messages read policy
-- ("Message: can read if channel accessible").
DROP POLICY IF EXISTS "Anyone can read reactions in their channels" ON public.discussion_message_reactions;
CREATE POLICY "Members can read reactions in their channels"
  ON public.discussion_message_reactions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.discussion_messages dm
      JOIN public.discussion_channels dc ON dc.id = dm.channel_id
      WHERE dm.id = discussion_message_reactions.message_id
        AND (
          (dc.scope = 'course' AND public.is_enrolled_or_professor(dc.section_id, auth.uid()))
          OR (dc.scope = 'team' AND public.is_team_member(dc.team_id, auth.uid()))
        )
    )
  );

DROP POLICY IF EXISTS "Users can insert own reactions" ON public.discussion_message_reactions;
CREATE POLICY "Users can insert own reactions" ON public.discussion_message_reactions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.discussion_messages dm
      JOIN public.discussion_channels dc ON dc.id = dm.channel_id
      WHERE dm.id = discussion_message_reactions.message_id
        AND (
          (dc.scope = 'course' AND public.is_enrolled_or_professor(dc.section_id, auth.uid()))
          OR (dc.scope = 'team' AND public.is_team_member(dc.team_id, auth.uid()))
        )
    )
  );

-- ── 3. project_chat_message_reactions ──────────────────────────────────────
-- Mirrors the project_chat_messages read policy (team membership).
DROP POLICY IF EXISTS "Anyone can read reactions in their channels" ON public.project_chat_message_reactions;
CREATE POLICY "Members can read reactions in their channels"
  ON public.project_chat_message_reactions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_chat_messages pcm
      JOIN public.project_chat_channels pcc ON pcc.id = pcm.channel_id
      WHERE pcm.id = project_chat_message_reactions.message_id
        AND public.is_team_member(pcc.team_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can insert own reactions" ON public.project_chat_message_reactions;
CREATE POLICY "Users can insert own reactions" ON public.project_chat_message_reactions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.project_chat_messages pcm
      JOIN public.project_chat_channels pcc ON pcc.id = pcm.channel_id
      WHERE pcm.id = project_chat_message_reactions.message_id
        AND public.is_team_member(pcc.team_id, auth.uid())
    )
  );

COMMIT;
