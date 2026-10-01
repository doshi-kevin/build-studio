-- Migration: rename the canonical "topics" domain to "skills" (data-preserving).
--
-- Renames tables/columns/indexes/constraints/functions from the merged
-- topic-mastery feature so the whole system speaks "skills". Uses ALTER … RENAME
-- throughout — NO drop/recreate of data-bearing tables, so all rows are kept.
--   topics            → skills
--   activity_topics   → activity_skills   (topic_id → skill_id)
--   topic_mastery     → skill_mastery     (topic_id → skill_id)
-- `parent_id` and `student_ability` are unchanged (student_ability carries no
-- topic in its name/columns). The realtime publication membership follows the
-- table across a rename (OID-based), so no publication change is needed.
--
-- Deliberately retained (renaming these needs a jsonb data migration across every
-- course_sections.settings row — tracked as a follow-up, not this migration):
--   • the section-settings config key  settings->'topicMastery'
--   • the enabled-feature toggle key value (nav label is renamed in code)
-- Created: 2026-07-07

-- ── Tables ────────────────────────────────────────────────────────
ALTER TABLE public.topics          RENAME TO skills;
ALTER TABLE public.activity_topics RENAME TO activity_skills;
ALTER TABLE public.topic_mastery   RENAME TO skill_mastery;

-- ── Columns (topic_id → skill_id) ─────────────────────────────────
ALTER TABLE public.activity_skills RENAME COLUMN topic_id TO skill_id;
ALTER TABLE public.skill_mastery   RENAME COLUMN topic_id TO skill_id;

-- ── Standalone indexes (constraint-backed ones renamed via constraints below) ──
ALTER INDEX public.idx_topics_parent            RENAME TO idx_skills_parent;
ALTER INDEX public.idx_topics_section           RENAME TO idx_skills_section;
ALTER INDEX public.idx_topics_section_parent    RENAME TO idx_skills_section_parent;
ALTER INDEX public.idx_activity_topics_activity RENAME TO idx_activity_skills_activity;
ALTER INDEX public.idx_activity_topics_section  RENAME TO idx_activity_skills_section;
ALTER INDEX public.idx_activity_topics_topic    RENAME TO idx_activity_skills_skill;
ALTER INDEX public.idx_topic_mastery_section    RENAME TO idx_skill_mastery_section;
ALTER INDEX public.idx_topic_mastery_student    RENAME TO idx_skill_mastery_student;
ALTER INDEX public.idx_topic_mastery_topic      RENAME TO idx_skill_mastery_skill;

-- ── Constraints (pk / unique / fk / check) — index names follow constraint rename ──
ALTER TABLE public.skills RENAME CONSTRAINT topics_pkey                 TO skills_pkey;
ALTER TABLE public.skills RENAME CONSTRAINT topics_source_check         TO skills_source_check;
ALTER TABLE public.skills RENAME CONSTRAINT topics_name_check           TO skills_name_check;
ALTER TABLE public.skills RENAME CONSTRAINT topics_institution_id_fkey  TO skills_institution_id_fkey;
ALTER TABLE public.skills RENAME CONSTRAINT topics_parent_id_fkey       TO skills_parent_id_fkey;
ALTER TABLE public.skills RENAME CONSTRAINT topics_section_id_fkey      TO skills_section_id_fkey;

ALTER TABLE public.activity_skills RENAME CONSTRAINT activity_topics_pkey                 TO activity_skills_pkey;
ALTER TABLE public.activity_skills RENAME CONSTRAINT activity_topics_activity_type_check  TO activity_skills_activity_type_check;
ALTER TABLE public.activity_skills RENAME CONSTRAINT activity_topics_section_id_fkey      TO activity_skills_section_id_fkey;
ALTER TABLE public.activity_skills RENAME CONSTRAINT activity_topics_institution_id_fkey  TO activity_skills_institution_id_fkey;
ALTER TABLE public.activity_skills RENAME CONSTRAINT activity_topics_topic_id_fkey        TO activity_skills_skill_id_fkey;
ALTER TABLE public.activity_skills RENAME CONSTRAINT activity_topics_activity_type_activity_id_topic_id_key TO activity_skills_activity_type_activity_id_skill_id_key;

ALTER TABLE public.skill_mastery RENAME CONSTRAINT topic_mastery_pkey                TO skill_mastery_pkey;
ALTER TABLE public.skill_mastery RENAME CONSTRAINT topic_mastery_score_range         TO skill_mastery_score_range;
ALTER TABLE public.skill_mastery RENAME CONSTRAINT topic_mastery_student_id_fkey     TO skill_mastery_student_id_fkey;
ALTER TABLE public.skill_mastery RENAME CONSTRAINT topic_mastery_institution_id_fkey TO skill_mastery_institution_id_fkey;
ALTER TABLE public.skill_mastery RENAME CONSTRAINT topic_mastery_topic_id_fkey       TO skill_mastery_skill_id_fkey;
ALTER TABLE public.skill_mastery RENAME CONSTRAINT topic_mastery_section_id_fkey     TO skill_mastery_section_id_fkey;
ALTER TABLE public.skill_mastery RENAME CONSTRAINT topic_mastery_student_id_topic_id_key TO skill_mastery_student_id_skill_id_key;

-- ── RLS policies — rename only the two that named "topics" (predicates
-- auto-track the table/column rename). The skill_mastery policies already read
-- "… mastery" and need no rename. ──
ALTER POLICY "Professors and TAs read section topics"          ON public.skills          RENAME TO "Professors and TAs read section skills";
ALTER POLICY "Professors and TAs read activity-topic mappings" ON public.activity_skills RENAME TO "Professors and TAs read activity-skill mappings";

-- ── Functions — rename + rewrite bodies to the new table/column names ──
-- plpgsql bodies are opaque text to the planner, so a table/column rename does
-- NOT update them; we recreate under the new names and drop the old ones.

CREATE OR REPLACE FUNCTION public._upsert_skill_node(p_section_id uuid, p_institution_id uuid, p_parent_id uuid, p_node jsonb, p_position integer)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
declare
  v_id uuid := nullif(p_node->>'id', '')::uuid;
  v_exists boolean;
begin
  if v_id is not null then
    select true into v_exists
    from public.skills where id = v_id and section_id = p_section_id;
  end if;

  if coalesce(v_exists, false) then
    update public.skills set
      parent_id = p_parent_id,
      name = p_node->>'name',
      source = p_node->>'source',
      placement_pinned = coalesce((p_node->>'pinned')::boolean, false),
      position = p_position,
      updated_at = now()
    where id = v_id and section_id = p_section_id;
    return v_id;
  end if;

  insert into public.skills
    (section_id, institution_id, parent_id, name, source, placement_pinned, position)
  values
    (p_section_id, p_institution_id, p_parent_id, p_node->>'name', p_node->>'source',
     coalesce((p_node->>'pinned')::boolean, false), p_position)
  returning id into v_id;
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_skill_review(p_section_id uuid, p_institution_id uuid, p_skills jsonb)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
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
  for v_main in select * from jsonb_array_elements(coalesce(p_skills, '[]'::jsonb))
  loop
    v_main_id := public._upsert_skill_node(p_section_id, p_institution_id, null, v_main, v_main_pos);
    if v_main_id is not null then
      v_kept := array_append(v_kept, v_main_id);
      v_tracked := v_tracked + 1;
      v_sub_pos := 0;
      for v_sub in select * from jsonb_array_elements(coalesce(v_main->'subtopics', '[]'::jsonb))
      loop
        v_sub_id := public._upsert_skill_node(p_section_id, p_institution_id, v_main_id, v_sub, v_sub_pos);
        if v_sub_id is not null then
          v_kept := array_append(v_kept, v_sub_id);
          v_tracked := v_tracked + 1;
        end if;
        v_sub_pos := v_sub_pos + 1;
      end loop;
    end if;
    v_main_pos := v_main_pos + 1;
  end loop;

  delete from public.skills
  where section_id = p_section_id
    and not (id = any(v_kept));

  return v_tracked;
end;
$function$;

CREATE OR REPLACE FUNCTION public.merge_section_skill_mastery_config(p_section_id uuid, p_config jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.reorder_skills(p_section_id uuid, p_ordered_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  update public.skills t
  set position = o.ord - 1,
      updated_at = now()
  from unnest(p_ordered_ids) with ordinality as o(id, ord)
  where t.id = o.id and t.section_id = p_section_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.replace_section_skill_mastery(p_section_id uuid, p_institution_id uuid, p_rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  perform pg_advisory_xact_lock(hashtext(p_section_id::text));

  delete from public.skill_mastery where section_id = p_section_id;

  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 0 then
    insert into public.skill_mastery
      (section_id, institution_id, student_id, skill_id, score, state, updated_at)
    select
      p_section_id,
      p_institution_id,
      (e->>'student_id')::uuid,
      (e->>'skill_id')::uuid,
      (e->>'score')::numeric,
      coalesce(e->'state', '{}'::jsonb),
      now()
    from jsonb_array_elements(p_rows) as e;
  end if;
end;
$function$;

DROP FUNCTION IF EXISTS public._upsert_topic_node(uuid, uuid, uuid, jsonb, integer);
DROP FUNCTION IF EXISTS public.confirm_topic_review(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.merge_section_topic_mastery_config(uuid, jsonb);
DROP FUNCTION IF EXISTS public.reorder_topics(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.replace_section_topic_mastery(uuid, uuid, jsonb);

-- Restore the #330 hardening: CREATE OR REPLACE re-grants EXECUTE to PUBLIC by
-- default, so re-lock the recreated RPCs to service_role only (they run via the
-- admin client from ownership-checked server actions, never the browser).
REVOKE EXECUTE ON FUNCTION public._upsert_skill_node(uuid, uuid, uuid, jsonb, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.confirm_skill_review(uuid, uuid, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_section_skill_mastery_config(uuid, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reorder_skills(uuid, uuid[]) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.replace_section_skill_mastery(uuid, uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._upsert_skill_node(uuid, uuid, uuid, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_skill_review(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_section_skill_mastery_config(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reorder_skills(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_section_skill_mastery(uuid, uuid, jsonb) TO service_role;

COMMENT ON TABLE public.skills IS 'Canonical per-section skills (formerly "topics"): hierarchical via parent_id; referenced by activity_skills and skill_mastery.';
