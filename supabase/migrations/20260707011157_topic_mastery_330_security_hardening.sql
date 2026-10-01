-- Topic Mastery — security hardening from the #330 end-to-end review.
--
-- Two same-tenant (not cross-tenant) holes, closed defensively:
--
-- 1. The atomic-write functions (20260630174550) revoke from `public` and grant
--    to `service_role`, but Supabase's default privileges still leave them
--    EXECUTE-able by `anon`/`authenticated`. They're SECURITY INVOKER so RLS
--    already blocked the underlying writes, but a normal user token could still
--    call them. Revoke EXECUTE from anon/authenticated so there's no callable
--    surface at all.
--
-- 2. The professor/TA policies on topics / activity_topics / topic_mastery were
--    `FOR ALL`. Supabase grants DML to `authenticated` by default, so a `FOR ALL`
--    policy let a professor write these tables directly via PostgREST — most
--    importantly overwriting engine-computed `topic_mastery.score` with an
--    arbitrary value, bypassing the scoring engine. Every write in the app goes
--    through the admin (service_role) client after requireSectionWriter, so the
--    `authenticated` role needs READ only. Convert the three policies to
--    `FOR SELECT`. Reads (server components under the user session) and the
--    `topics` realtime subscription keep working; there is no client write path
--    to break (verified: no non-admin insert/update/delete on these tables).

-- ── 1. No callable surface for the atomic-write functions ────────────────────
revoke execute on function public.replace_section_topic_mastery(uuid, uuid, jsonb) from anon, authenticated;
revoke execute on function public.merge_section_topic_mastery_config(uuid, jsonb) from anon, authenticated;
revoke execute on function public.reorder_topics(uuid, uuid[]) from anon, authenticated;
revoke execute on function public._upsert_topic_node(uuid, uuid, uuid, jsonb, int) from anon, authenticated;
revoke execute on function public.confirm_topic_review(uuid, uuid, jsonb) from anon, authenticated;

-- ── 2. Read-only client policies (writes are admin-client-only) ──────────────
-- topics
drop policy if exists "Professors and TAs manage section topics" on public.topics;
create policy "Professors and TAs read section topics"
  on public.topics for select
  using (
    section_id in (
      select id from public.course_sections where professor_id = (select auth.uid())
    )
    or section_id in (
      select section_id from public.section_staff
      where staff_id = (select auth.uid()) and status = 'active' and ends_at > now() and role = 'ta'
    )
  );

-- activity_topics
drop policy if exists "Professors and TAs manage activity-topic mappings" on public.activity_topics;
create policy "Professors and TAs read activity-topic mappings"
  on public.activity_topics for select
  using (
    section_id in (
      select id from public.course_sections where professor_id = (select auth.uid())
    )
    or section_id in (
      select section_id from public.section_staff
      where staff_id = (select auth.uid()) and status = 'active' and ends_at > now() and role = 'ta'
    )
  );

-- topic_mastery — professor/TA read only; engine writes via service_role.
-- (The existing "Students read their own mastery" SELECT policy is unchanged.)
drop policy if exists "Professors and TAs manage section mastery" on public.topic_mastery;
create policy "Professors and TAs read section mastery"
  on public.topic_mastery for select
  using (
    section_id in (
      select id from public.course_sections where professor_id = (select auth.uid())
    )
    or section_id in (
      select section_id from public.section_staff
      where staff_id = (select auth.uid()) and status = 'active' and ends_at > now() and role = 'ta'
    )
  );
