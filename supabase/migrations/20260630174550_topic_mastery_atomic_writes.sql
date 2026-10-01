-- Atomic / batched writes for Topic Mastery (PR #276 review, round 3).
--
-- Four read-decide-write paths in the topic actions were non-atomic or N+1:
--   1. recomputeSectionMastery  — delete-then-insert across two statements:
--      concurrent recomputes could both delete then collide on the
--      (student_id, topic_id) insert, leaving the table half-rebuilt.
--   2. updateTopicMasteryConfig — read-merge-write of the whole
--      course_sections.settings blob: a concurrent Manage-Features write
--      clobbers it.
--   3. reorderTopics            — one UPDATE per id in a JS loop (N round-trips).
--   4. confirmTopicReview       — per-node update/insert in a JS loop, plus a
--      delete-stale, with no transaction: a mid-loop failure leaves a half-
--      written tree.
--
-- Each becomes a single round-trip that runs in one transaction. No new tables,
-- so no RLS changes. All functions are SECURITY INVOKER and granted to
-- service_role ONLY — they're called by the server actions via the admin client
-- AFTER requireSectionWriter authorizes the caller, and take section_id
-- explicitly, so there is no direct-PostgREST surface for these.

-- 1. Rebuild a section's topic_mastery atomically. An advisory xact lock keyed
--    on the section serializes concurrent recomputes so the delete+insert pair
--    can't interleave and collide on the (student_id, topic_id) unique key.
create or replace function public.replace_section_topic_mastery(
  p_section_id uuid,
  p_institution_id uuid,
  p_rows jsonb
) returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_section_id::text));

  delete from public.topic_mastery where section_id = p_section_id;

  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 0 then
    insert into public.topic_mastery
      (section_id, institution_id, student_id, topic_id, score, state, updated_at)
    select
      p_section_id,
      p_institution_id,
      (e->>'student_id')::uuid,
      (e->>'topic_id')::uuid,
      (e->>'score')::numeric,
      coalesce(e->'state', '{}'::jsonb),
      now()
    from jsonb_array_elements(p_rows) as e;
  end if;
end;
$$;

-- 2. Deep-merge a config patch into course_sections.settings->'topicMastery' in
--    one statement (top-level keys shallow-merged, stakeMultipliers merged one
--    level deeper) so a concurrent settings write can't clobber it.
create or replace function public.merge_section_topic_mastery_config(
  p_section_id uuid,
  p_config jsonb
) returns void
language plpgsql
as $$
begin
  update public.course_sections
  set settings = jsonb_set(
        coalesce(settings, '{}'::jsonb),
        '{topicMastery}',
        (coalesce(settings->'topicMastery', '{}'::jsonb) || (p_config - 'stakeMultipliers'))
          || jsonb_build_object(
               'stakeMultipliers',
               coalesce(settings->'topicMastery'->'stakeMultipliers', '{}'::jsonb)
                 || coalesce(p_config->'stakeMultipliers', '{}'::jsonb)
             ),
        true
      )
  where id = p_section_id;
end;
$$;

-- 3. Apply a sibling re-order in one statement, scoped to the section.
create or replace function public.reorder_topics(
  p_section_id uuid,
  p_ordered_ids uuid[]
) returns void
language plpgsql
as $$
begin
  update public.topics t
  set position = o.ord - 1,
      updated_at = now()
  from unnest(p_ordered_ids) with ordinality as o(id, ord)
  where t.id = o.id and t.section_id = p_section_id;
end;
$$;

-- Helper: update an existing topic node (when its id already belongs to the
-- section) or insert a new one; returns the resulting id. Mirrors the JS
-- upsertNode so confirm_topic_review can rebuild the tree server-side.
create or replace function public._upsert_topic_node(
  p_section_id uuid,
  p_institution_id uuid,
  p_parent_id uuid,
  p_node jsonb,
  p_position int
) returns uuid
language plpgsql
as $$
declare
  v_id uuid := nullif(p_node->>'id', '')::uuid;
  v_exists boolean;
begin
  if v_id is not null then
    select true into v_exists
    from public.topics where id = v_id and section_id = p_section_id;
  end if;

  if coalesce(v_exists, false) then
    update public.topics set
      parent_id = p_parent_id,
      name = p_node->>'name',
      source = p_node->>'source',
      placement_pinned = coalesce((p_node->>'pinned')::boolean, false),
      position = p_position,
      updated_at = now()
    where id = v_id and section_id = p_section_id;
    return v_id;
  end if;

  insert into public.topics
    (section_id, institution_id, parent_id, name, source, placement_pinned, position)
  values
    (p_section_id, p_institution_id, p_parent_id, p_node->>'name', p_node->>'source',
     coalesce((p_node->>'pinned')::boolean, false), p_position)
  returning id into v_id;
  return v_id;
end;
$$;

-- 4. Confirm a reviewed topic tree atomically: upsert every main + subtopic,
--    then delete the section's topics that weren't kept. Returns the count of
--    tracked nodes. One round-trip, one transaction.
create or replace function public.confirm_topic_review(
  p_section_id uuid,
  p_institution_id uuid,
  p_topics jsonb
) returns integer
language plpgsql
as $$
declare
  v_kept uuid[] := '{}';
  v_tracked int := 0;
  v_main jsonb;
  v_sub jsonb;
  v_main_id uuid;
  v_sub_id uuid;
  v_main_pos int := 0;
  v_sub_pos int;
begin
  for v_main in select * from jsonb_array_elements(coalesce(p_topics, '[]'::jsonb))
  loop
    v_main_id := public._upsert_topic_node(p_section_id, p_institution_id, null, v_main, v_main_pos);
    if v_main_id is not null then
      v_kept := array_append(v_kept, v_main_id);
      v_tracked := v_tracked + 1;
      v_sub_pos := 0;
      for v_sub in select * from jsonb_array_elements(coalesce(v_main->'subtopics', '[]'::jsonb))
      loop
        v_sub_id := public._upsert_topic_node(p_section_id, p_institution_id, v_main_id, v_sub, v_sub_pos);
        if v_sub_id is not null then
          v_kept := array_append(v_kept, v_sub_id);
          v_tracked := v_tracked + 1;
        end if;
        v_sub_pos := v_sub_pos + 1;
      end loop;
    end if;
    v_main_pos := v_main_pos + 1;
  end loop;

  delete from public.topics
  where section_id = p_section_id
    and not (id = any(v_kept));

  return v_tracked;
end;
$$;

revoke all on function public.replace_section_topic_mastery(uuid, uuid, jsonb) from public;
revoke all on function public.merge_section_topic_mastery_config(uuid, jsonb) from public;
revoke all on function public.reorder_topics(uuid, uuid[]) from public;
revoke all on function public._upsert_topic_node(uuid, uuid, uuid, jsonb, int) from public;
revoke all on function public.confirm_topic_review(uuid, uuid, jsonb) from public;

grant execute on function public.replace_section_topic_mastery(uuid, uuid, jsonb) to service_role;
grant execute on function public.merge_section_topic_mastery_config(uuid, jsonb) to service_role;
grant execute on function public.reorder_topics(uuid, uuid[]) to service_role;
grant execute on function public._upsert_topic_node(uuid, uuid, uuid, jsonb, int) to service_role;
grant execute on function public.confirm_topic_review(uuid, uuid, jsonb) to service_role;
