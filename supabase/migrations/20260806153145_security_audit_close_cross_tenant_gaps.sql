-- Whole-system security audit — close four confirmed cross-tenant gaps.
--
-- Each block below fixes a site that cleared the audit's promotion gate: a concrete
-- request an authenticated user at Institution A can send today to reach Institution B.
-- Verdicts were rendered against the LIVE database (pg_policies / pg_proc), not against
-- migration text. See goals/security-audit-to-clean/ledger.json.
--
-- Policies are dropped before being recreated (no CREATE POLICY IF NOT EXISTS in
-- Postgres — a re-run must not halt partway and silently skip later statements).


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. storage: course-materials uploads were unscoped  (audit C4 / A1)
--
-- WAS: with check (bucket_id = 'course-materials' AND auth.uid() IS NOT NULL)
-- Any authenticated user could create an object at ANY key in the bucket —
-- including inside another institution's section prefix or another professor's
-- warehouse/ prefix. Reads and deletes were already path-scoped, so this was a
-- write-side tenant-boundary violation (no cross-tenant read, no overwrite: the
-- bucket has no UPDATE policy, so upsert is refused).
--
-- Every legitimate browser upload path is preserved. Enumerated from the call
-- sites of uploadFile()/uploadWarehouseFile() in src/lib/supabase/storage.ts:
--   {sectionId}/…                        modules, quiz-images, about-banners,
--                                        about-cta, quiz-ai-uploads   → staff
--   {sectionId}/project-submissions/…    StudentSubmissionTab         → any member
--   about/{sectionId}/images             ImageBlockEditor             → staff
--   announcements/{sectionId}            AnnouncementForm             → staff
--   formula-sheets/{sectionId}/{quizId}  QuizInfoStep                 → staff
--   warehouse/{professorId}              UploadFileDialog             → self
--
-- DO NOT "correct" this policy to match what is in the bucket. A census of live
-- objects shows prefixes that match NO branch above, and every one is fine:
--   extracted-images/{sec}/{item}   3,796 objects, written ONLY by createAdminClient()
--                                   (pdf.ts, pptx.ts, modules/actions.ts) — service_role
--                                   bypasses RLS, so this INSERT policy never applies.
--   quiz-images/{sec}/…             legacy shape; current code writes {sec}/quiz-images/…
--   project-submissions/{team}/…    legacy shape; current code writes {sec}/project-submissions/…
-- The two legacy shapes are already unreadable under the existing SELECT policy, which
-- keys on foldername[1] being a section uuid. Widening this policy to admit them would
-- reopen the cross-tenant write hole it exists to close.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists "Course materials: authenticated can upload" on storage.objects;

create policy "Course materials: members can upload to their own scope"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'course-materials'
    and (
      -- Students (and staff) may write only under a section's project-submissions
      -- subtree, and only for a section they belong to.
      (
        (storage.foldername(name))[2] = 'project-submissions'
        and public.is_section_member(public.safe_cast_uuid((storage.foldername(name))[1]))
      )
      -- The rest of a section's prefix is staff-only.
      or public.is_section_owner_or_staff(public.safe_cast_uuid((storage.foldername(name))[1]))
      or (
        (storage.foldername(name))[1] = 'formula-sheets'
        and public.is_section_owner_or_staff(public.safe_cast_uuid((storage.foldername(name))[2]))
      )
      or (
        (storage.foldername(name))[1] = 'announcements'
        and public.is_section_owner_or_staff(public.safe_cast_uuid((storage.foldername(name))[2]))
      )
      or (
        (storage.foldername(name))[1] = 'about'
        and public.is_section_owner_or_staff(public.safe_cast_uuid((storage.foldername(name))[2]))
      )
      or (
        (storage.foldername(name))[1] = 'warehouse'
        and public.safe_cast_uuid((storage.foldername(name))[2]) = (select auth.uid())
      )
    )
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. storage: proctoring-snapshots uploads were unscoped  (audit C4)
--
-- WAS: with check (bucket_id = 'proctoring-snapshots' AND auth.uid() IS NOT NULL)
-- Any authenticated user could plant objects at any path — i.e. fabricate exam
-- proctoring evidence inside another institution's section prefix.
--
-- No client ever uploads here: both writers (saveProctoringSnapshot in
-- student/…/quizzes/actions.ts and saveAssessmentProctoringSnapshot in
-- student/…/assignments/assessment-actions.ts) go through createAdminClient(),
-- which bypasses RLS. Reads are already staff-only. So the correct fix is to
-- remove the client write path entirely rather than narrow it.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists "Proctoring snapshots: authenticated can upload" on storage.objects;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. course intel tables were readable across every institution  (audit C2)
--
-- WAS, on all 8 tables: using (status = 'active' AND auth.uid() IS NOT NULL)
-- These tables carry no institution_id, and `authenticated` holds a direct
-- SELECT grant, so any logged-in user could issue one PostgREST request and read
-- every course review, survival tip, Q&A post and professor rating at every
-- institution — including review_text, self-reported grade_received, and the
-- author_id behind rows the compose UI promises are anonymous.
--
-- Narrowed to the audience the feature is actually built for: members of a
-- section of that course. All app access to these tables goes through the admin
-- client, so this narrowing changes no supported code path; it closes the
-- direct-PostgREST path that bypasses the app entirely.
-- ─────────────────────────────────────────────────────────────────────────────

-- Membership predicate for a course (any of its sections). Mirrors the shape of
-- the existing is_section_member(): the caller is resolved from auth.uid()
-- internally and is never passed in, so the function cannot be used as an oracle
-- to probe someone else's enrollment.
create or replace function public.is_course_member(p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from course_sections cs
    where cs.course_id = p_course_id
      and cs.professor_id = (select auth.uid())
  )
  or exists (
    select 1
    from course_sections cs
    join section_staff ss on ss.section_id = cs.id
    where cs.course_id = p_course_id
      and ss.staff_id = (select auth.uid())
      and ss.status = 'active'
      and ss.ends_at > now()
  )
  or exists (
    select 1
    from course_sections cs
    join enrollments e on e.section_id = cs.id
    where cs.course_id = p_course_id
      and e.student_id = (select auth.uid())
      and e.status in ('enrolled', 'completed')
  );
$function$;

revoke execute on function public.is_course_member(uuid) from public, anon;
grant execute on function public.is_course_member(uuid) to authenticated, service_role;

-- 3a. Tables that carry course_id directly.
drop policy if exists "Authenticated users can read active reviews" on public.course_reviews;
create policy "Course members can read active reviews"
  on public.course_reviews for select to authenticated
  using (status = 'active' and public.is_course_member(course_id));

drop policy if exists "Authenticated users can read active questions" on public.course_questions;
create policy "Course members can read active questions"
  on public.course_questions for select to authenticated
  using (status = 'active' and public.is_course_member(course_id));

drop policy if exists "Authenticated users can read active tips" on public.course_tips;
create policy "Course members can read active tips"
  on public.course_tips for select to authenticated
  using (status = 'active' and public.is_course_member(course_id));

drop policy if exists "Authenticated users can read active resources" on public.course_resources;
create policy "Course members can read active resources"
  on public.course_resources for select to authenticated
  using (status = 'active' and public.is_course_member(course_id));

drop policy if exists "Authenticated users can read active professor insights" on public.course_professor_insights;
create policy "Course members can read active professor insights"
  on public.course_professor_insights for select to authenticated
  using (status = 'active' and public.is_course_member(course_id));

-- 3b. Tables that reach course_id through a parent row.
drop policy if exists "Authenticated users can read active answers" on public.course_answers;
create policy "Course members can read active answers"
  on public.course_answers for select to authenticated
  using (
    status = 'active'
    and exists (
      select 1 from public.course_questions cq
      where cq.id = course_answers.question_id
        and public.is_course_member(cq.course_id)
    )
  );

drop policy if exists "Authenticated users can read tip votes" on public.course_tip_votes;
create policy "Course members can read tip votes"
  on public.course_tip_votes for select to authenticated
  using (
    exists (
      select 1 from public.course_tips ct
      where ct.id = course_tip_votes.tip_id
        and public.is_course_member(ct.course_id)
    )
  );

drop policy if exists "Authenticated users can read answer votes" on public.course_answer_votes;
create policy "Course members can read answer votes"
  on public.course_answer_votes for select to authenticated
  using (
    exists (
      select 1
      from public.course_answers ca
      join public.course_questions cq on cq.id = ca.question_id
      where ca.id = course_answer_votes.answer_id
        and public.is_course_member(cq.course_id)
    )
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. lc_user_can_access_room() accepted an arbitrary p_user_id  (audit C3)
--
-- SECURITY DEFINER, EXECUTE granted to `authenticated` (required — it backs the
-- realtime.messages channel policies and the live-classroom-decks storage
-- policy, which are evaluated as the calling role). It took p_user_id as a
-- parameter without checking it against the caller, making it an authz oracle
-- over RPC: "is user X a member of room Y?".
--
-- The same caller-identity guard was added to get_visible_profile_ids() and
-- can_access_phase() in 20260715191137; this function has the identical shape
-- and was missed by that pass. Every call site already passes auth.uid()
--   realtime.messages "lc room read access"/"lc room ephem write access"/
--     "lc room presence read access"  → lc_user_can_access_room((select auth.uid()), …)
--   storage.objects  "Live classroom decks: read access"
--                                     → lc_user_can_access_room(auth.uid(), …)
-- so the guard is transparent to all of them. (Five policies reference it in total:
-- the fourth realtime one is "lc room presence write access", same auth.uid() shape.)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.lc_user_can_access_room(p_user_id uuid, p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1
    FROM lc_rooms r
    WHERE r.id = p_room_id
      AND (
        r.prof_id = p_user_id
        OR EXISTS (
          SELECT 1
          FROM enrollments e
          WHERE e.section_id = r.section_id
            AND e.student_id = p_user_id
            AND e.status IN ('enrolled', 'completed')
        )
      )
  )
  -- Caller-identity guard: only the caller (every policy passes auth.uid()) or
  -- the service role may resolve a given user's room access. A direct rpc call
  -- naming someone else returns false rather than answering.
  AND (
    p_user_id = (select auth.uid())
    OR (select auth.role()) = 'service_role'
  );
$function$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. quiz_attempts: max_attempts was enforced by a read-decide-write race  (audit B6)
--
-- startAttempt() and startAdaptiveAttempt() both count submitted attempts in JS,
-- compare against quizzes.max_attempts, and then INSERT — three separate awaits.
-- N concurrent calls all read the same pre-write count, all pass the check, and all
-- insert. The student submits each one and the grades page keeps the BEST score, so
-- a one-shot exam becomes unlimited retakes. There was no unique constraint behind
-- the insert to stop it (confirmed via pg_constraint / pg_indexes).
--
-- A student is never meant to hold two in-progress attempts on the same quiz — both
-- functions already look for an existing one and resume it instead of creating a
-- second. Making that an enforced invariant serialises the whole start path: the
-- losers of the race get 23505 instead of a second attempt, and each subsequent
-- start re-reads the submitted count against fresh state, so the cap holds.
--
-- Verified before shipping: zero (quiz_id, student_id) pairs currently hold more
-- than one in_progress row in prod, so this index builds without conflict.
-- ─────────────────────────────────────────────────────────────────────────────

create unique index if not exists uq_quiz_attempt_one_in_progress
  on public.quiz_attempts (quiz_id, student_id)
  where status = 'in_progress';


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. UPDATE policies with no WITH CHECK let a row be RE-PARENTED  (audit C2)
--
-- For UPDATE, Postgres re-applies USING to the NEW row when WITH CHECK is omitted.
-- That is sufficient where USING names the parent object, and insufficient wherever
-- USING names only an owner id — the owner predicate stays true no matter what the
-- caller rewrites the foreign keys to. Concretely, today:
--
--   * project_members: a student PATCHes their OWN membership row's team_id to a
--     sibling team and becomes a member of it — is_team_member() then flips true for
--     that team's docs, chat, availability, meetings and project_grades. One request,
--     ordinary student. (team_invitations reaches the same end state by re-pointing a
--     self-issued invitation and letting the accept action insert the membership with
--     the admin client.)
--   * projects: re-point created_by-owned project at a foreign section_id.
--   * the six course_* intel tables: re-parent own content into a course the author
--     never took, and reverse a moderator's status='removed' back to 'active'.
--
-- WITH CHECK cannot express this: it only sees NEW, and the invariant is "these
-- columns did not change". So this uses the mechanism the schema already uses for
-- exactly this problem on profiles — a BEFORE UPDATE trigger (compare
-- prevent_profile_privilege_escalation). service_role is exempt, which keeps every
-- app path working: all of these tables are written by server actions through
-- createAdminClient(), so only the direct-PostgREST path is constrained.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.prevent_reparenting()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  col text;
begin
  -- Server actions run as service_role and are already authorized in application
  -- code; this guard exists for the anon-key PostgREST path.
  if (select auth.role()) = 'service_role' then
    return new;
  end if;

  -- Column names come from the trigger definition below, never from user input.
  -- Compared via to_jsonb so there is no dynamic SQL.
  foreach col in array tg_argv loop
    if to_jsonb(old) ->> col is distinct from to_jsonb(new) ->> col then
      -- errcode matters: without it plpgsql raises SQLSTATE P0001, which PostgREST
      -- maps to a 500. 'insufficient_privilege' (42501) surfaces as a 403, so a
      -- blocked re-parenting attempt reads as "denied" rather than "server broke".
      raise exception 'insufficient_privilege'
        using errcode = 'insufficient_privilege',
              detail = format('%I.%I cannot be changed by this role', tg_table_name, col);
    end if;
  end loop;

  return new;
end;
$function$;

revoke execute on function public.prevent_reparenting() from public, anon, authenticated;

drop trigger if exists prevent_reparenting on public.project_members;
create trigger prevent_reparenting before update on public.project_members
  for each row execute function public.prevent_reparenting('project_id', 'team_id', 'user_id', 'role');

drop trigger if exists prevent_reparenting on public.team_invitations;
create trigger prevent_reparenting before update on public.team_invitations
  for each row execute function public.prevent_reparenting('team_id', 'project_id', 'invited_user_id');

drop trigger if exists prevent_reparenting on public.projects;
create trigger prevent_reparenting before update on public.projects
  for each row execute function public.prevent_reparenting('section_id', 'created_by');

drop trigger if exists prevent_reparenting on public.course_questions;
create trigger prevent_reparenting before update on public.course_questions
  for each row execute function public.prevent_reparenting('course_id', 'author_id', 'status');

drop trigger if exists prevent_reparenting on public.course_answers;
create trigger prevent_reparenting before update on public.course_answers
  for each row execute function public.prevent_reparenting('question_id', 'author_id', 'status');

drop trigger if exists prevent_reparenting on public.course_tips;
create trigger prevent_reparenting before update on public.course_tips
  for each row execute function public.prevent_reparenting('course_id', 'author_id', 'status');

drop trigger if exists prevent_reparenting on public.course_resources;
create trigger prevent_reparenting before update on public.course_resources
  for each row execute function public.prevent_reparenting('course_id', 'author_id', 'status');

drop trigger if exists prevent_reparenting on public.course_reviews;
create trigger prevent_reparenting before update on public.course_reviews
  for each row execute function public.prevent_reparenting('course_id', 'author_id', 'status');

drop trigger if exists prevent_reparenting on public.course_professor_insights;
create trigger prevent_reparenting before update on public.course_professor_insights
  for each row execute function public.prevent_reparenting('course_id', 'professor_id', 'author_id', 'status');


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. lc_rooms: a professor could create a room in a section they don't teach  (audit C2)
--
-- WAS: for all ... using (prof_id = auth.uid()) with check (prof_id = auth.uid())
-- section_id was never checked, so any professor could INSERT a room naming a
-- foreign section. The AFTER INSERT trigger then broadcasts 'room_started' to that
-- section's students, the room appears in their UI, and as they join, the attacker's
-- ownership of the room makes that section's attendance, poll/quiz responses,
-- transcriptions and annotations readable to them.
--
-- Every sibling professor policy in the schema scopes by course_sections.professor_id;
-- this one simply didn't. Adding that predicate to both arms.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists "prof manages own rooms" on public.lc_rooms;
create policy "prof manages own rooms"
  on public.lc_rooms for all to authenticated
  using (
    prof_id = (select auth.uid())
    and section_id in (
      select cs.id from course_sections cs where cs.professor_id = (select auth.uid())
    )
  )
  with check (
    prof_id = (select auth.uid())
    and section_id in (
      select cs.id from course_sections cs where cs.professor_id = (select auth.uid())
    )
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. course_questions INSERT had no course-membership check  (audit C2)
--
-- WAS: with check (author_id = auth.uid())
-- Its six sibling intel INSERT policies all additionally require the course to be
-- one the author is or was enrolled in; this one didn't, so any authenticated user
-- could POST a question onto any course's board given a course UUID — and course
-- UUIDs for the whole institution ship to every student in the catalog payload.
-- Aligned with the siblings. (Whether the askQuestion SERVER ACTION should also
-- require membership is an open product question — it writes with the admin client
-- and so is unaffected by this policy; recorded as NEEDS-HUMAN in the ledger.)
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists "Authenticated users can create questions" on public.course_questions;
create policy "Course members can create questions"
  on public.course_questions for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.is_course_member(course_id)
  );
