-- Studio Step 9: course context for the AI builder (docs/reference/studio-agent-harness.md,
-- "Course material").
--
-- No new table and no copy of course content. The builder reads the professor's existing
-- material through one eligibility function, studio_course_units, which decides which
-- sources Studio may touch at all and the disclosure class of every unit:
--
--   released   students can see it now
--   scheduled  visible and published, but the module opens later (or a live-classroom deck
--              not shared yet); the builder may read it, plugin code may not copy it
--   withheld   hidden item, unpublished module, draft assignment, or a syllabus marked tba;
--              never shown to the model, only counted and used by the copy guard
--
-- Search, the per-turn re-read, the copy guard and the release review all read through it.
-- Everything here is server-only: executable by service_role alone, called by the builder
-- harness and the release review after their own access checks. Scope comes from the
-- caller's trusted run or installation row, and every function filters institution and
-- section itself, so a caller bug can't widen it.
--
-- Provenance: studio_plugin_projects.material_sources holds the scheduled source keys any
-- run of the project showed the model that students still can't see, added in
-- studio_builder_end's commit. Sources that have opened since are pruned there; if more
-- than 96 unopened ones remain, the oldest are dropped and material_incomplete is set, so
-- the release review says its list is incomplete instead of silently missing one.
-- studio_plugin_versions copies both columns at Save and never changes. Keys only, never
-- course text.

-- ── Provenance columns (existing server-only tables; RLS and grants unchanged) ──
alter table public.studio_plugin_projects
  add column if not exists material_sources jsonb not null default '[]'::jsonb;
alter table public.studio_plugin_versions
  add column if not exists material_sources jsonb not null default '[]'::jsonb;
alter table public.studio_plugin_projects
  add column if not exists material_incomplete boolean not null default false;
alter table public.studio_plugin_versions
  add column if not exists material_incomplete boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'studio_plugin_projects_material_sources_check') then
    alter table public.studio_plugin_projects
      add constraint studio_plugin_projects_material_sources_check
      check (jsonb_typeof(material_sources) = 'array' and octet_length(material_sources::text) <= 16384);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'studio_plugin_versions_material_sources_check') then
    alter table public.studio_plugin_versions
      add constraint studio_plugin_versions_material_sources_check
      check (jsonb_typeof(material_sources) = 'array' and octet_length(material_sources::text) <= 16384);
  end if;
end $$;

-- ── The one eligibility function ──
-- Unit keys: p:<item>:<page> (page 0 is the item's title and description), m:<module>,
-- a:<assignment>, s:<block>:<week> (syllabus). p_ids, when given, narrows items, modules
-- and assignments before any text work (the re-read and the guard pass only their keys).
-- Bounded by construction: at most 400 items, 300 pages an item, 8,000 characters a unit.
create or replace function public.studio_course_units(
  p_institution uuid,
  p_section     uuid,
  p_now         timestamptz,
  p_ids         uuid[] default null
)
returns table (
  unit_key     text,
  source_kind  text,
  module_id    uuid,
  module_title text,
  week_number  integer,
  item_type    text,
  page         integer,
  title        text,
  heading      text,
  body         text,
  disclosure   text,
  opens_at     timestamptz
)
language sql
stable
as $$
  with sec as (
    select cs.id, cs.settings
      from public.course_sections cs
     where cs.id = p_section and cs.institution_id = p_institution
  ),
  items as (
    select mi.id, mi.title, mi.description, mi.item_type, mi.content,
           m.id as module_id, m.title as module_title, m.week_number,
           case
             when mi.is_visible and m.is_published and (m.unlock_date is null or m.unlock_date <= p_now) then 'released'
             when (mi.is_visible and m.is_published) or m.system_kind = 'classroom_uploads' then 'scheduled'
             else 'withheld'
           end as disclosure,
           case when mi.is_visible and m.is_published and m.unlock_date > p_now then m.unlock_date end as opens_at
      from sec
      join public.modules m on m.section_id = sec.id
      join public.module_items mi on mi.module_id = m.id
     where mi.item_type in ('lecture', 'reference', 'note', 'link')
       -- System modules are out, except live-classroom decks (never Quiz Uploads).
       and (m.system_kind is null or (m.system_kind = 'classroom_uploads' and mi.item_type = 'lecture'))
       and (p_ids is null or mi.id = any(p_ids))
     order by m.position, mi.position, mi.id
     limit 400
  )
  -- Item page 0: title, description and a note's body.
  select 'p:' || i.id || ':0', 'item', i.module_id, i.module_title, i.week_number, i.item_type, 0,
         i.title, null::text,
         left(concat_ws(E'\n', nullif(i.description, ''), nullif(i.content ->> 'body', '')), 8000),
         i.disclosure, i.opens_at
    from items i
   where coalesce(i.title, '') <> '' or coalesce(i.description, '') <> '' or coalesce(i.content ->> 'body', '') <> ''
  union all
  -- Item extraction pages. Every page carries the item title (weight A) and its headings.
  select 'p:' || i.id || ':' || pg.page_no, 'item', i.module_id, i.module_title, i.week_number, i.item_type, pg.page_no,
         i.title, pg.heading, pg.body, i.disclosure, i.opens_at
    from items i
    cross join lateral (
      select case when e.value ->> 'pageNumber' ~ '^[0-9]{1,4}$' then (e.value ->> 'pageNumber')::integer else e.ord::integer end as page_no,
             left(array_to_string(array(select jsonb_array_elements_text(case when jsonb_typeof(e.value -> 'headings') = 'array' then e.value -> 'headings' else '[]'::jsonb end)), ' / '), 300) as heading,
             left(coalesce(e.value ->> 'text', ''), 8000) as body
        from jsonb_array_elements(case when jsonb_typeof(i.content -> 'extraction' -> 'pages') = 'array' then i.content -> 'extraction' -> 'pages' else '[]'::jsonb end)
             with ordinality as e(value, ord)
       where e.ord <= 300
    ) pg
   where pg.page_no >= 1
  union all
  -- Modules: title and description. Never instructor_note.
  select 'm:' || m.id, 'module', m.id, m.title, m.week_number, null, null,
         m.title, null, left(coalesce(m.description, ''), 8000),
         case
           when m.is_published and (m.unlock_date is null or m.unlock_date <= p_now) then 'released'
           when m.is_published then 'scheduled'
           else 'withheld'
         end,
         case when m.is_published and m.unlock_date > p_now then m.unlock_date end
    from sec
    join public.modules m on m.section_id = sec.id
   where m.system_kind is null
     and (p_ids is null or m.id = any(p_ids))
  union all
  -- Syllabus weeks, from the About page's syllabus blocks.
  select 's:' || b.ord || ':' || w.ord, 'syllabus', null, null,
         case when w.value ->> 'week' ~ '^[0-9]{1,2}$' then (w.value ->> 'week')::integer end,
         null, null,
         left(concat_ws(': ', 'Week ' || coalesce(w.value ->> 'week', '?'), nullif(w.value ->> 'topic', '')), 300),
         null,
         left(concat_ws(E'\n', nullif(w.value ->> 'description', ''), nullif(w.value ->> 'readings', '')), 8000),
         case when b.value -> 'data' -> 'tba' = 'true'::jsonb then 'withheld' else 'released' end,
         null
    from sec
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(sec.settings -> 'about' -> 'blocks') = 'array' then sec.settings -> 'about' -> 'blocks' else '[]'::jsonb end
    ) with ordinality as b(value, ord)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(b.value -> 'data' -> 'weeks') = 'array' then b.value -> 'data' -> 'weeks' else '[]'::jsonb end
    ) with ordinality as w(value, ord)
   where b.value ->> 'type' = 'syllabus' and b.ord <= 20 and w.ord <= 60
  union all
  -- Assignments: title, description, guidelines. Never rubric, settings or references.
  select 'a:' || a.id, 'assignment', a.module_id, m.title, m.week_number, null, null,
         a.title, null,
         left(concat_ws(E'\n', nullif(a.description, ''), nullif(a.guidelines, '')), 8000),
         case
           when a.status in ('published', 'closed') then 'released'
           when a.status = 'scheduled' then 'scheduled'
           else 'withheld'
         end,
         case when a.status = 'scheduled' then a.scheduled_publish_at end
    from sec
    join public.assignments a on a.section_id = sec.id and a.institution_id = p_institution
    left join public.modules m on m.id = a.module_id
   where (p_ids is null or a.id = any(p_ids))
$$;

-- The query, as an OR of its lexemes: one page needn't hold every keyword. Lexemes with
-- a backslash or quote are dropped rather than escaped. Null when nothing is left.
create or replace function public.studio_course_tsquery(p_query text)
returns tsquery
language sql
immutable
as $$
  select nullif(array_to_string(array(
           select '''' || l || ''''
             from unnest(tsvector_to_array(to_tsvector('english', left(coalesce(p_query, ''), 200)))) l
            where l !~ '[\\'']'
            limit 12
         ), ' | '), '')::tsquery
$$;

-- Ranked search over released and scheduled units. Excerpts (ts_headline, no markup) are
-- computed only for the top rows. A unit in a focus module gets a bounded boost, never a
-- sort ahead of relevance. One extra row with a null unit_key carries the number of
-- withheld sources that matched, so the builder can say "not published yet" by count.
create or replace function public.studio_course_search(
  p_institution uuid,
  p_section     uuid,
  p_now         timestamptz,
  p_query       text,
  p_focus       uuid[],
  p_limit       integer
)
returns table (
  unit_key         text,
  source_kind      text,
  module_id        uuid,
  module_title     text,
  week_number      integer,
  item_type        text,
  page             integer,
  title            text,
  heading          text,
  disclosure       text,
  opens_at         timestamptz,
  rank             real,
  excerpt          text,
  withheld_matches integer
)
language sql
stable
as $$
  with q as (
    select public.studio_course_tsquery(p_query) as tsq
  ),
  -- At most 2,000 units are read, in a stable order (not course order), before any text work.
  units as (
    select u.*
      from q
      cross join lateral public.studio_course_units(p_institution, p_section, p_now, null) u
     where q.tsq is not null
     order by u.module_id nulls last, u.unit_key
     limit 2000
  ),
  hits as (
    select u.*,
           (ts_rank_cd(v.tsv, q.tsq)
            * case when u.module_id = any(coalesce(p_focus, '{}'::uuid[])) then 1.5 else 1 end)::real as rank,
           q.tsq
      from q, units u
      cross join lateral (
        select setweight(to_tsvector('english', coalesce(u.title, '')), 'A') ||
               setweight(to_tsvector('english', coalesce(u.heading, '')), 'B') ||
               setweight(to_tsvector('english', coalesce(u.body, '')), 'D') as tsv
      ) v
     where v.tsv @@ q.tsq
  ),
  top as (
    select * from hits
     where disclosure in ('released', 'scheduled')
     order by rank desc, unit_key
     limit least(greatest(coalesce(p_limit, 6), 1), 20)
  )
  select t.unit_key, t.source_kind, t.module_id, t.module_title, t.week_number, t.item_type, t.page,
         t.title, t.heading, t.disclosure, t.opens_at, t.rank,
         ts_headline('english', coalesce(t.body, ''), t.tsq,
                     'StartSel="", StopSel="", MaxFragments=2, MaxWords=40, MinWords=15, FragmentDelimiter=" ... "'),
         null::integer
    from top t
  union all
  select null, null, null, null, null, null, null, null, null, null, null, null, null,
         (select count(distinct split_part(h.unit_key, ':', 2))::integer from hits h where h.disclosure = 'withheld')
$$;

-- The per-turn re-read: the given keys, if still released or scheduled, with an excerpt
-- for the search's own words. A key that no longer comes back is gone from the prompt.
create or replace function public.studio_course_excerpts(
  p_institution uuid,
  p_section     uuid,
  p_now         timestamptz,
  p_query       text,
  p_keys        text[]
)
returns table (
  unit_key     text,
  source_kind  text,
  module_id    uuid,
  module_title text,
  week_number  integer,
  item_type    text,
  page         integer,
  title        text,
  heading      text,
  disclosure   text,
  opens_at     timestamptz,
  excerpt      text
)
language sql
stable
as $$
  with q as (
    select public.studio_course_tsquery(p_query) as tsq
  ),
  ids as (
    select array(
      select split_part(k, ':', 2)::uuid from unnest(coalesce(p_keys, '{}'::text[])) k
       where k ~ '^[pma]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9]{1,4})?$'
    ) as v
  )
  select u.unit_key, u.source_kind, u.module_id, u.module_title, u.week_number, u.item_type, u.page,
         u.title, u.heading, u.disclosure, u.opens_at,
         case when q.tsq is null then left(coalesce(u.body, ''), 600)
              else ts_headline('english', coalesce(u.body, ''), q.tsq,
                               'StartSel="", StopSel="", MaxFragments=2, MaxWords=40, MinWords=15, FragmentDelimiter=" ... "')
         end
    from q, ids
    cross join lateral public.studio_course_units(p_institution, p_section, p_now, ids.v) u
   where u.unit_key = any(p_keys)
     and u.disclosure in ('released', 'scheduled')
$$;

-- The copy guard's and the release review's read: the given keys in every disclosure
-- class, with their whole (capped) text. Never shown to a model.
create or replace function public.studio_course_sources(
  p_institution uuid,
  p_section     uuid,
  p_now         timestamptz,
  p_keys        text[]
)
returns table (
  unit_key     text,
  source_kind  text,
  module_title text,
  week_number  integer,
  item_type    text,
  page         integer,
  title        text,
  disclosure   text,
  opens_at     timestamptz,
  body         text
)
language sql
stable
as $$
  with ids as (
    select array(
      select split_part(k, ':', 2)::uuid from unnest(coalesce(p_keys, '{}'::text[])) k
       where k ~ '^[pma]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9]{1,4})?$'
    ) as v
  )
  select u.unit_key, u.source_kind, u.module_title, u.week_number, u.item_type, u.page, u.title,
         u.disclosure, u.opens_at, u.body
    from ids
    cross join lateral public.studio_course_units(p_institution, p_section, p_now, ids.v) u
   where u.unit_key = any(p_keys)
$$;

-- Adds a run's scheduled source keys to a project's provenance. Keys must have the unit
-- shape; each is stamped with the build section, because a version can be installed in
-- other sections and its sources always resolve against the one it was built in. Newest
-- last; studio_material_prune applies the cap.
create or replace function public.studio_material_union(p_existing jsonb, p_added jsonb, p_section uuid)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(entry order by ord), '[]'::jsonb)
    from (
      select entry, max(ord) as ord
        from (
          select e.value as entry, e.ord
            from jsonb_array_elements(case when jsonb_typeof(p_existing) = 'array' then p_existing else '[]'::jsonb end)
                 with ordinality as e(value, ord)
           where jsonb_typeof(e.value) = 'object'
          union all
          select jsonb_build_object('k', a.value #>> '{}', 's', p_section::text), 100000 + a.ord
            from jsonb_array_elements(case when jsonb_typeof(p_added) = 'array' then p_added else '[]'::jsonb end)
                 with ordinality as a(value, ord)
           where p_section is not null
             and jsonb_typeof(a.value) = 'string'
             and (a.value #>> '{}') ~ '^(p:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,4}|[ma]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
        ) x
       group by entry
    ) kept
$$;

-- Keeps the provenance entries whose source students still can't see (scheduled, or
-- withheld after the model saw it), newest last, at most p_max. A source that has opened
-- or no longer exists can't leak and is dropped. Returns {entries, incomplete}: incomplete
-- is true when unopened entries had to be dropped for the cap.
create or replace function public.studio_material_prune(p_institution uuid, p_entries jsonb, p_max integer)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $$
declare
  v_section text;
  v_keys text[];
  v_open text[] := '{}';
  v_kept jsonb;
  v_count integer;
begin
  for v_section in
    select distinct e.value ->> 's' from jsonb_array_elements(p_entries) e
     where (e.value ->> 's') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  loop
    v_keys := array(select e.value ->> 'k' from jsonb_array_elements(p_entries) e where e.value ->> 's' = v_section);
    v_open := v_open || array(
      select v_section || '|' || u.unit_key
        from public.studio_course_sources(p_institution, v_section::uuid, now(), v_keys) u
       where u.disclosure <> 'released'
    );
  end loop;
  select coalesce(jsonb_agg(e.value order by e.ord), '[]'::jsonb), count(*)
    into v_kept, v_count
    from jsonb_array_elements(p_entries) with ordinality as e(value, ord)
   where (e.value ->> 's') || '|' || (e.value ->> 'k') = any(v_open);
  if v_count <= p_max then
    return jsonb_build_object('entries', v_kept, 'incomplete', false);
  end if;
  return jsonb_build_object(
    'entries', (select jsonb_agg(x.value order by x.ord) from jsonb_array_elements(v_kept) with ordinality as x(value, ord) where x.ord > v_count - p_max),
    'incomplete', true);
end;
$$;

-- studio_builder_end, unchanged except that a commit also adds the run's scheduled source
-- keys (work.material.sources) to the project's provenance, in the same transaction and
-- before work is cleared. Undo never removes them: over-warning is the safe direction.
create or replace function public.studio_builder_end(
  p_run        uuid,
  p_token      uuid,
  p_status     text,
  p_error_code text,
  p_result     jsonb,
  p_snapshot   jsonb,
  p_active_ms  integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_rev bigint;
  v_hash text;
  v_material jsonb;
begin
  -- A commit locks the project row before the run row: the order studio_builder_start and
  -- studio_builder_undo take them in, so a start racing a commit waits instead of deadlocking.
  if p_snapshot is not null then
    perform 1 from public.studio_plugin_projects
     where id = (select project_id from public.studio_plugin_builder_runs where id = p_run)
       for update;
  end if;
  select * into r from public.studio_plugin_builder_runs where id = p_run for update;
  if not found or r.status <> 'running' or r.claim_token is distinct from p_token then
    return jsonb_build_object('outcome', 'fence');
  end if;
  update public.studio_plugin_builder_runs set active_ms = active_ms + greatest(p_active_ms, 0) where id = p_run;
  if r.cancel_requested_at is not null and p_status <> 'cancelled' then
    perform public.studio_builder_close(p_run, 'cancelled', null, 'cancelled');
    return jsonb_build_object('outcome', 'cancelled');
  end if;

  if p_snapshot is not null then
    v_hash := p_snapshot ->> 'hash';
    select draft_rev into v_rev from public.studio_plugin_projects where id = r.project_id for update;
    if v_rev <> r.base_rev then
      update public.studio_plugin_builder_runs
         set status = 'blocked', error_code = 'draft_changed', work = null, claim_token = null,
             result = public.studio_builder_sql_result('blocked', 'draft_changed')
       where id = p_run;
      perform public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
        'kind', 'system', 'tool_call_id', 'sys:ended', 'status', 'done', 'label', 'run.blocked',
        'args_summary', jsonb_build_object('event', 'ended'), 'result_summary', jsonb_build_object('reason', 'draft_changed')));
      return jsonb_build_object('outcome', 'conflict');
    end if;
    insert into public.studio_plugin_snapshots
      (project_id, hash, institution_id, compiler, manifest, files, student_bundle, professor_bundle, check_summary, created_by_run)
    values (r.project_id, v_hash, r.institution_id, p_snapshot ->> 'compiler', p_snapshot -> 'manifest', p_snapshot -> 'files',
            p_snapshot ->> 'student_bundle', p_snapshot ->> 'professor_bundle', p_snapshot -> 'check_summary', p_run)
    on conflict (project_id, hash) do nothing;
    -- Provenance: this run's scheduled sources join the project's, then whatever has opened
    -- since is pruned and the newest 96 unopened sources are kept.
    select public.studio_material_prune(
             r.institution_id,
             public.studio_material_union(p.material_sources, r.work -> 'material' -> 'sources', r.section_id),
             96)
      into v_material
      from public.studio_plugin_projects p where p.id = r.project_id;
    -- The old head becomes the undo target. Identical content leaves the target as it was.
    update public.studio_plugin_projects
       set draft_head_hash = v_hash, draft_rev = draft_rev + 1,
           draft_undo_hash = case when draft_head_hash is distinct from v_hash then draft_head_hash else draft_undo_hash end,
           material_sources = v_material -> 'entries',
           material_incomplete = material_incomplete or (v_material ->> 'incomplete')::boolean
     where id = r.project_id and draft_rev = r.base_rev;
  end if;

  update public.studio_plugin_builder_runs
     set status = p_status, error_code = p_error_code, result = p_result, result_hash = v_hash,
         work = null, claim_token = null, pending_approval = null, waiting_until = null
   where id = p_run;
  perform public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
    'kind', 'system', 'tool_call_id', 'sys:ended', 'status', 'done', 'label', 'run.' || p_status,
    'args_summary', jsonb_build_object('event', case when v_hash is null then 'ended' else 'committed' end),
    'result_summary', jsonb_build_object('reason', coalesce(p_error_code, p_status))));
  return jsonb_build_object('outcome', 'ended');
end;
$$;

revoke all on function public.studio_course_units(uuid, uuid, timestamptz, uuid[]) from public, anon, authenticated;
revoke all on function public.studio_course_tsquery(text) from public, anon, authenticated;
revoke all on function public.studio_course_search(uuid, uuid, timestamptz, text, uuid[], integer) from public, anon, authenticated;
revoke all on function public.studio_course_excerpts(uuid, uuid, timestamptz, text, text[]) from public, anon, authenticated;
revoke all on function public.studio_course_sources(uuid, uuid, timestamptz, text[]) from public, anon, authenticated;
revoke all on function public.studio_material_union(jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.studio_material_prune(uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_end(uuid, uuid, text, text, jsonb, jsonb, integer) from public, anon, authenticated;

grant execute on function public.studio_course_units(uuid, uuid, timestamptz, uuid[]) to service_role;
grant execute on function public.studio_course_tsquery(text) to service_role;
grant execute on function public.studio_course_search(uuid, uuid, timestamptz, text, uuid[], integer) to service_role;
grant execute on function public.studio_course_excerpts(uuid, uuid, timestamptz, text, text[]) to service_role;
grant execute on function public.studio_course_sources(uuid, uuid, timestamptz, text[]) to service_role;
grant execute on function public.studio_material_union(jsonb, jsonb, uuid) to service_role;
grant execute on function public.studio_material_prune(uuid, jsonb, integer) to service_role;
grant execute on function public.studio_builder_end(uuid, uuid, text, text, jsonb, jsonb, integer) to service_role;
