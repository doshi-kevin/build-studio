-- Teach the discussion RLS helpers about section_staff (#747), WITHOUT handing graders
-- writes the application refuses them.
--
-- ── The bug ──────────────────────────────────────────────────────────────────────
-- is_enrolled_or_professor() recognised only the section's professor and enrolled
-- students, so a TA or grader failed every policy built on it.
--
-- Blast radius is wider than the issue reported. It is not only reactions: the
-- professor Discussions tree that TAs and graders reuse renders its message list from
-- useDiscussionMessages (src/lib/discussion/hooks.ts), which reads discussion_messages
-- with the BROWSER client. Under RLS that returned an empty set for staff with no
-- error, so the initial fetch, loadMore pagination and the realtime subscription were
-- all silently empty for them.
--
-- ── The helper's REAL dependents: 7 policies across 4 objects ────────────────────
-- Enumerated from pg_policies against production, not from memory. An earlier draft of
-- this migration said "five policies across three tables" and that undercount is
-- exactly what let a storage WRITE grant through unexamined — the two storage policies
-- live in an unrelated migration (00000000000027_direct_messages.sql) and are not named
-- after any table under discussion.
--
--   public.discussion_channels           SELECT   Course channel: enrolled or professor can read
--   public.discussion_messages           SELECT   Message: can read if channel accessible
--   public.discussion_messages           INSERT   Message: can insert if channel accessible and active
--   public.discussion_message_reactions  SELECT   Members can read reactions in their channels
--   public.discussion_message_reactions  INSERT   Users can insert own reactions
--   storage.objects                      SELECT   Chat attachments: read
--   storage.objects                      INSERT   Chat attachments: upload
--
-- ── Why one widened helper is not enough ─────────────────────────────────────────
-- Widening the single helper would have granted graders discussion_messages INSERT and
-- chat-attachments UPLOAD. The app deliberately refuses both:
--
--   * sendDiscussionMessage gates on canWriteAsStaff(), which excludes graders.
--   * STAFF_ROLE_DESCRIPTIONS.grader — shown to the professor in the role picker —
--     promises "Grading only … no announcement or classroom access."
--   * professor/courses/[sectionId]/discussions/page.tsx says graders are read-only.
--   * The attachment upload path has NO server action at all, so RLS is its only
--     control.
--
-- The database is browser-reachable with the anon key, so canWriteAsStaff is not a
-- boundary a grader has to pass through. Leaving the DB more permissive than the app is
-- the exact inversion the "RLS is the last line of defence" rule exists to prevent.
--
-- So: two predicates.
--
--   is_enrolled_or_professor  →  READ, plus reactions INSERT.  Admits TA + grader.
--   can_author_in_section     →  authoring writes.             Admits TA only.
--
-- Reactions INSERT deliberately stays on the read helper: toggleDiscussionReaction
-- gates on access.ok, which already admits graders, so the two layers agree.
--
-- Both mirror verifySectionAccess (src/lib/auth/section-access.ts) exactly —
-- status = 'active' AND ends_at > now() — so a revoked or expired assistant loses
-- database access in the same instant they lose application access. Without the
-- ends_at bound this would become a way for a removed assistant to keep reading.
-- section_staff.ends_at is NOT NULL, so there is no NULL > now() hole.

-- ── 1. Read access: professor, enrolled student, or any active assistant ─────────
CREATE OR REPLACE FUNCTION public.is_enrolled_or_professor(p_section_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.course_sections
    WHERE id = p_section_id AND professor_id = p_user_id
  ) THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.enrollments
    WHERE section_id = p_section_id
      AND student_id = p_user_id
      AND status IN ('enrolled', 'completed')
  ) THEN
    RETURN TRUE;
  END IF;

  -- Active, unexpired course assistants (TA or grader). Read scope.
  IF EXISTS (
    SELECT 1 FROM public.section_staff
    WHERE section_id = p_section_id
      AND staff_id   = p_user_id
      AND status     = 'active'
      AND ends_at    > now()
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$function$;

-- ── 2. Authoring access: same, but assistants must be a TA ──────────────────────
CREATE OR REPLACE FUNCTION public.can_author_in_section(p_section_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.course_sections
    WHERE id = p_section_id AND professor_id = p_user_id
  ) THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.enrollments
    WHERE section_id = p_section_id
      AND student_id = p_user_id
      AND status IN ('enrolled', 'completed')
  ) THEN
    RETURN TRUE;
  END IF;

  -- TA only. Graders are read-only for authoring, matching canWriteAsStaff().
  IF EXISTS (
    SELECT 1 FROM public.section_staff
    WHERE section_id = p_section_id
      AND staff_id   = p_user_id
      AND role       = 'ta'
      AND status     = 'active'
      AND ends_at    > now()
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$function$;

-- Server-only? No — these are called from RLS policies evaluated as the requesting
-- role, so anon/authenticated must retain EXECUTE. Stated explicitly because the house
-- rule for new functions is to revoke it (see reference_supabase_function_grants).

-- ── 3. Repoint the two AUTHORING writes at the stricter predicate ────────────────
-- Recreated verbatim from the live definitions apart from the swapped helper, so the
-- team/DM branches and the channel-active condition are unchanged.

DROP POLICY IF EXISTS "Message: can insert if channel accessible and active" ON public.discussion_messages;
CREATE POLICY "Message: can insert if channel accessible and active"
  ON public.discussion_messages FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1
        FROM public.discussion_channels dc
       WHERE dc.id = discussion_messages.channel_id
         AND dc.status = 'active'
         AND (
           (dc.scope = 'course' AND public.can_author_in_section(dc.section_id, auth.uid()))
           OR (dc.scope = 'team' AND public.is_team_member(dc.team_id, auth.uid()))
         )
    )
  );

DROP POLICY IF EXISTS "Chat attachments: upload" ON storage.objects;
CREATE POLICY "Chat attachments: upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'chat-attachments'
    AND owner = auth.uid()
    AND (
      (
        (storage.foldername(name))[1] !~ '^[a-zA-Z]+$'
        AND public.is_team_member(((storage.foldername(name))[1])::uuid, auth.uid())
      )
      OR (
        (storage.foldername(name))[1] = 'dms'
        AND public.is_dm_participant(((storage.foldername(name))[2])::uuid, auth.uid())
      )
      OR (
        (storage.foldername(name))[1] = 'discussions'
        AND public.can_author_in_section(((storage.foldername(name))[2])::uuid, auth.uid())
      )
    )
  );

-- No new index: idx_section_staff_staff already covers (staff_id, status), which is the
-- shape both helpers drive, and section_staff is a small table.
