-- Per-student "pin a material to a page" for the roadmap (canvas node modal).
--
-- Stores the student's chosen start page alongside their check-off in the same
-- roadmap_progress JSONB: nodeProgress[nodeId] = { checkedOff?, pinnedPage?, … }.
-- No new table — reuses roadmap_progress, whose RLS already scopes every row to
-- `auth.uid() = student_id`.
--
-- Two functions here:
--   1. roadmap_set_node_page — set/clear the pinned page (null clears).
--   2. roadmap_set_node_checkoff — REPLACED to MERGE into the existing node
--      object instead of overwriting it. The old version rebuilt the whole
--      per-node object on every toggle, which would wipe a sibling pinnedPage
--      (and vice-versa). Both functions now merge with `||` so check-off and
--      pin coexist on the same node.
--
-- SECURITY INVOKER (default): RLS on roadmap_progress still applies, so a direct
-- PostgREST caller can only ever write their OWN row. The server action calls
-- these with the service-role client AFTER verifying enrolment, passing the
-- verified user id. node_id is length-capped in SQL too (the function is granted
-- to `authenticated`), so a direct caller can't bloat their JSONB row — which
-- getStudentJourneys reads for the whole class.

create or replace function public.roadmap_set_node_checkoff(
  p_section_id uuid,
  p_student_id uuid,
  p_node_id text,
  p_checked_off boolean
) returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_node_id is null or length(p_node_id) > 200 then
    raise exception 'node_id missing or too long';
  end if;

  insert into public.roadmap_progress (section_id, student_id, progress, updated_at)
  values (
    p_section_id,
    p_student_id,
    jsonb_build_object(
      'version', 1,
      'nodeProgress', jsonb_build_object(
        p_node_id, jsonb_build_object('checkedOff', p_checked_off, 'lastViewedAt', now())
      ),
      'lastAccessedAt', now()
    ),
    now()
  )
  on conflict (section_id, student_id) do update
    set progress = jsonb_set(
          jsonb_set(
            coalesce(public.roadmap_progress.progress, '{"version":1,"nodeProgress":{}}'::jsonb),
            array['nodeProgress', p_node_id],
            coalesce(public.roadmap_progress.progress -> 'nodeProgress' -> p_node_id, '{}'::jsonb)
              || jsonb_build_object('checkedOff', p_checked_off, 'lastViewedAt', now()),
            true
          ),
          '{lastAccessedAt}', to_jsonb(now()), true
        ),
        updated_at = now();
end;
$$;

create or replace function public.roadmap_set_node_page(
  p_section_id uuid,
  p_student_id uuid,
  p_node_id text,
  p_page integer
) returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_node_id is null or length(p_node_id) > 200 then
    raise exception 'node_id missing or too long';
  end if;
  -- Bound the page in SQL too (the action caps it, but this is granted to
  -- `authenticated`, so a direct PostgREST caller must be constrained as well).
  if p_page is not null and (p_page < 1 or p_page > 10000) then
    raise exception 'page out of range';
  end if;

  insert into public.roadmap_progress (section_id, student_id, progress, updated_at)
  values (
    p_section_id,
    p_student_id,
    jsonb_build_object(
      'version', 1,
      'nodeProgress', jsonb_build_object(
        p_node_id, jsonb_build_object('pinnedPage', p_page, 'lastViewedAt', now())
      ),
      'lastAccessedAt', now()
    ),
    now()
  )
  on conflict (section_id, student_id) do update
    set progress = jsonb_set(
          jsonb_set(
            coalesce(public.roadmap_progress.progress, '{"version":1,"nodeProgress":{}}'::jsonb),
            array['nodeProgress', p_node_id],
            coalesce(public.roadmap_progress.progress -> 'nodeProgress' -> p_node_id, '{}'::jsonb)
              || jsonb_build_object('pinnedPage', p_page, 'lastViewedAt', now()),
            true
          ),
          '{lastAccessedAt}', to_jsonb(now()), true
        ),
        updated_at = now();
end;
$$;

revoke all on function public.roadmap_set_node_checkoff(uuid, uuid, text, boolean) from public;
grant execute on function public.roadmap_set_node_checkoff(uuid, uuid, text, boolean) to authenticated, service_role;
revoke all on function public.roadmap_set_node_page(uuid, uuid, text, integer) from public;
grant execute on function public.roadmap_set_node_page(uuid, uuid, text, integer) to authenticated, service_role;
