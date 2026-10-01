-- Atomic, concurrency-safe merge of a course section's settings JSONB.
--
-- course_sections.settings holds several independent concerns under one column:
--   about           — the About page's block array (autosaves 1.5s after a keystroke)
--   enabledFeatures — what STUDENTS can see (the verifyFeatureEnabled gate)
--   sidebarHidden   — the professor's own nav
--   sidebarOrder    — the professor's own nav order
--
-- Every writer did a read-modify-write: SELECT settings -> spread
-- `{ ...currentSettings, myKey }` in JS -> UPDATE the whole blob. Four writers
-- race today (saveAboutContent, toggleCourseFeature, setCourseSidebarVisibility,
-- reorderCourseFeatures), and the About one fires on a 1.5s autosave debounce, so
-- it is running constantly while a professor works. Whoever writes last wins with
-- a stale snapshot: toggling a feature during an About autosave silently reverts
-- the toggle, and because enabledFeatures is the student-visibility gate, that
-- reappears to students as a feature switching itself back off.
--
-- This folds the merge into ONE atomic UPDATE in Postgres. `settings || p_patch`
-- shallow-merges only the caller's own top-level keys, and `- p_remove` drops keys
-- the caller means to clear. Because the read and the write happen in the same
-- statement, a concurrent writer's keys are never clobbered — only the exact keys
-- each caller names change.
--
-- Same shape and same security model as public.merge_assignment_settings
-- (20260729120000), which fixed the identical bug on assignments.settings.
--
-- SECURITY: locked to service_role. The only callers are server actions using the
-- admin client, each AFTER verifying the caller owns the section. Not granted to
-- authenticated/anon, so it is not reachable from the browser through PostgREST.
create or replace function public.merge_course_section_settings(
  p_section_id uuid,
  p_patch jsonb default '{}'::jsonb,
  p_remove text[] default array[]::text[]
) returns void
language plpgsql
-- Pinned search_path: satisfies the function_search_path_mutable advisor and
-- matches the sibling functions in this repo. References below are schema-qualified.
set search_path to 'public'
as $$
begin
  update public.course_sections cs
  set settings = (coalesce(cs.settings, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb))
                 - coalesce(p_remove, array[]::text[])
  where cs.id = p_section_id;
end;
$$;

-- Supabase's default privileges grant EXECUTE on new public-schema functions to
-- anon + authenticated, so revoking from PUBLIC alone leaves them callable from
-- the browser. Revoke from those roles explicitly, then grant only service_role.
revoke all on function public.merge_course_section_settings(uuid, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.merge_course_section_settings(uuid, jsonb, text[]) to service_role;
