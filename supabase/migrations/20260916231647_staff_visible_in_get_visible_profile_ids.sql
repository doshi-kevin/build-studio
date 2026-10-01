-- get_visible_profile_ids() never accounts for section_staff (TA/grader), so a
-- course staff member's profiles row is invisible to their own section's students
-- and professor under the `profiles` SELECT policy this function backs. Symptom:
-- TA/grader authored messages render as "Unknown" anywhere the app embeds a
-- profiles join (discussion_messages -> profiles, MessageBubble.tsx's null-author
-- fallback). Their access to the underlying content itself is unaffected — a
-- separate, already-shipped fix (20260821174702_staff_aware_discussion_rls.sql)
-- correctly granted section_staff read access to discussion_messages/channels.
-- This is the missing piece: profiles identity resolution, not content access.
--
-- Two directions, deliberately gated differently (checked with a second opinion
-- from two independent reviewers before writing this):
--
--   * Viewer sees staff (student->staff, professor->staff): UNFILTERED by
--     section_staff.status/ends_at. This function's EXISTING branches (classmates,
--     professor-of-section) already carry no enrollment-status filter at all — a
--     dropped/withdrawn student's name still resolves in old messages, because
--     this function does identity resolution, not access control. A former TA's
--     identity must stay resolvable the same way, or historical messages regress
--     to "Unknown" the moment their assignment ends.
--
--   * Staff sees others (staff->student, staff->professor): gated on
--     status = 'active' AND ends_at > now(). This direction is a live access
--     grant — a departed/removed TA reading a current student's profile fields —
--     and must expire the instant staff access is revoked, matching
--     is_enrolled_or_professor()'s own stated intent in the sibling migration
--     above: "a revoked or expired assistant loses database access in the same
--     instant they lose application access."
--
-- No co-staff (TA-sees-TA) branch: out of scope for the reported bug, not worth
-- the added join cost for a case nobody hit.

create or replace function public.get_visible_profile_ids(p_user_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select vid from (
    -- Own profile
    select p_user_id as vid
    union
    -- Teammates
    select distinct pm2.user_id
    from public.project_members pm1
    join public.project_members pm2 on pm1.team_id = pm2.team_id
    where pm1.user_id = p_user_id
    union
    -- Classmates (same enrolled section)
    select distinct e2.student_id
    from public.enrollments e1
    join public.enrollments e2 on e1.section_id = e2.section_id
    where e1.student_id = p_user_id
    union
    -- Students enrolled in sections the user owns (professor sees their students)
    select distinct e.student_id
    from public.course_sections cs
    join public.enrollments e on e.section_id = cs.id
    where cs.professor_id = p_user_id
    union
    -- Students/professors can see the professor of their enrolled sections
    select distinct cs.professor_id
    from public.enrollments e
    join public.course_sections cs on cs.id = e.section_id
    where e.student_id = p_user_id
    union
    -- Course staff (past or present), visible to enrolled students of that section
    select distinct ss.staff_id
    from public.section_staff ss
    join public.enrollments e on e.section_id = ss.section_id
    where e.student_id = p_user_id
    union
    -- Course staff (past or present), visible to the professor of that section
    select distinct ss.staff_id
    from public.section_staff ss
    join public.course_sections cs on cs.id = ss.section_id
    where cs.professor_id = p_user_id
    union
    -- Staff can see the enrolled students of sections they ACTIVELY staff
    select distinct e.student_id
    from public.section_staff ss
    join public.enrollments e on e.section_id = ss.section_id
    where ss.staff_id = p_user_id
      and ss.status = 'active'
      and ss.ends_at > now()
    union
    -- Staff can see the professor of sections they ACTIVELY staff
    select distinct cs.professor_id
    from public.section_staff ss
    join public.course_sections cs on cs.id = ss.section_id
    where ss.staff_id = p_user_id
      and ss.status = 'active'
      and ss.ends_at > now()
  ) resolved
  -- Caller-identity guard: only the caller (policy passes auth.uid()) or the
  -- service role may resolve a given user's visible set. A direct rpc call from
  -- anon (auth.uid() null) or an authenticated user passing a foreign id gets 0 rows.
  where p_user_id = (select auth.uid())
     or (select auth.role()) = 'service_role';
$function$;

revoke execute on function public.get_visible_profile_ids(uuid) from public, anon;
grant execute on function public.get_visible_profile_ids(uuid) to service_role, authenticated;

-- Both this function's pre-existing branches and the two new ones above filter on
-- course_sections.professor_id / enrollments.student_id. Neither has a leading-
-- column index today: 00000000000000_base_schema.sql created both, but
-- 00000000000070_reconcile_prod_schema_drift.sql dropped them as "migration-only"
-- without a replacement, so this function (old and new branches alike) has been
-- running a sequential scan on both tables. Pure-additive, safe to add here.
create index if not exists idx_course_sections_professor on public.course_sections(professor_id);
create index if not exists idx_enrollments_student on public.enrollments(student_id);
