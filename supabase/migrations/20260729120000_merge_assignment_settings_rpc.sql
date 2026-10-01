-- Atomic, concurrency-safe merge of an assignment's settings JSONB.
--
-- The studio writers — savePublishSettings, saveAssignmentRubric,
-- saveAssignmentRubricDraft, publishStudioAssignment — each did a
-- read-modify-write: SELECT settings → spread `{ ...existingSettings, myKeys }`
-- in JS → UPDATE the whole blob. With the 800ms Publish-tab autosave now live,
-- two writers racing (Rubrics tab + Publish tab, or a quick tab switch) each
-- start from a STALE snapshot, so whoever writes last drops the other's keys —
-- resurrecting a deleted rubricDraft, dropping a just-saved rubric, etc.
--
-- This folds the merge into ONE atomic UPDATE in Postgres: `settings || p_patch`
-- shallow-merges only the caller's own top-level keys (accepts, assessment,
-- rubric, rubricDraft, ...) and `- p_remove` drops keys the caller wants gone
-- (rubric promotion clears rubricDraft). Because the merge reads and writes in
-- the same statement, a concurrent writer's keys are never clobbered — only the
-- exact keys each caller touches change.
--
-- Scalar columns are applied in the same statement so settings + scalars stay
-- consistent. p_cols carries only the columns a caller means to change: a key
-- PRESENT (even with a JSON null value) is applied; a key ABSENT is left as-is.
-- The `?` presence test is what lets a caller set a nullable column (due_at,
-- scheduled_publish_at) to NULL without every other caller having to pass it.
-- The column set is a fixed whitelist — no dynamic SQL, nothing outside it can
-- be written through this function.
--
-- SECURITY: locked to service_role — the ONLY callers are the studio server
-- actions via the admin client, AFTER each verifies section ownership and that
-- the assignment belongs to the section. The WHERE also pins section_id as a
-- second guard. NOT granted to authenticated/anon, so it is not reachable from
-- the browser via PostgREST (no direct-call authz hole).
create or replace function public.merge_assignment_settings(
  p_assignment_id uuid,
  p_section_id uuid,
  p_patch jsonb default '{}'::jsonb,
  p_remove text[] default array[]::text[],
  p_cols jsonb default '{}'::jsonb
) returns void
language plpgsql
-- Pinned search_path: satisfies the function_search_path_mutable advisor and matches the
-- sibling functions in this repo. All object references below are already schema-qualified.
set search_path to 'public'
as $$
begin
  update public.assignments a
  set
    settings = (coalesce(a.settings, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb)) - coalesce(p_remove, array[]::text[]),
    due_at = case when p_cols ? 'due_at'
      then nullif(p_cols->>'due_at', '')::timestamptz else a.due_at end,
    is_graded = case when p_cols ? 'is_graded'
      then (p_cols->>'is_graded')::boolean else a.is_graded end,
    points = case when p_cols ? 'points'
      then (p_cols->>'points')::numeric else a.points end,
    status = case when p_cols ? 'status'
      then p_cols->>'status' else a.status end,
    submission_type = case when p_cols ? 'submission_type'
      then p_cols->>'submission_type' else a.submission_type end,
    title = case when p_cols ? 'title'
      then p_cols->>'title' else a.title end,
    description = case when p_cols ? 'description'
      then p_cols->>'description' else a.description end,
    scheduled_publish_at = case when p_cols ? 'scheduled_publish_at'
      then nullif(p_cols->>'scheduled_publish_at', '')::timestamptz else a.scheduled_publish_at end,
    published_at = case when p_cols ? 'published_at'
      then nullif(p_cols->>'published_at', '')::timestamptz else a.published_at end,
    publish_notified_at = case when p_cols ? 'publish_notified_at'
      then nullif(p_cols->>'publish_notified_at', '')::timestamptz else a.publish_notified_at end,
    updated_at = now()
  where a.id = p_assignment_id and a.section_id = p_section_id;
end;
$$;

-- Supabase's default privileges grant EXECUTE on new public-schema functions to
-- anon + authenticated, so revoking from PUBLIC alone leaves them callable from
-- the browser. Revoke from those roles explicitly, then grant only service_role.
revoke all on function public.merge_assignment_settings(uuid, uuid, jsonb, text[], jsonb) from public, anon, authenticated;
grant execute on function public.merge_assignment_settings(uuid, uuid, jsonb, text[], jsonb) to service_role;
