-- Atomic check-off for a student's roadmap_progress node (PR #199 review).
--
-- Replaces a read-merge-write upsert in setMyNodeCheckedOff that had a
-- lost-update race: two concurrent toggles each read the same JSONB, merged
-- only their own node, and the last write clobbered the other. This folds the
-- merge into ONE statement (insert … on conflict … do update set progress =
-- jsonb_set(…)), so concurrent toggles to different nodes can't stomp each other.
--
-- SECURITY INVOKER (default): RLS on roadmap_progress still applies, so a direct
-- PostgREST caller can only ever write their OWN row (the table's insert/update
-- policies are `auth.uid() = student_id`). The server action calls it with the
-- service-role client AFTER verifying enrollment, passing the verified user id.
--
-- node_id is length-capped IN SQL too: the action caps it at 200, but this
-- function is granted to `authenticated`, so a direct rpc caller could otherwise
-- pass a multi-MB key and bloat their own roadmap_progress row — which
-- getStudentJourneys reads for the whole class. The guard keeps that abuse from
-- degrading the professor roster load.

create or replace function public.roadmap_set_node_checkoff(
  p_section_id uuid,
  p_student_id uuid,
  p_node_id text,
  p_checked_off boolean
) returns void
language plpgsql
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
            jsonb_build_object('checkedOff', p_checked_off, 'lastViewedAt', now()),
            true
          ),
          '{lastAccessedAt}', to_jsonb(now()), true
        ),
        updated_at = now();
end;
$$;

revoke all on function public.roadmap_set_node_checkoff(uuid, uuid, text, boolean) from public;
grant execute on function public.roadmap_set_node_checkoff(uuid, uuid, text, boolean) to authenticated, service_role;
