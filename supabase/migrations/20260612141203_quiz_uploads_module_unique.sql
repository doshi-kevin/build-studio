-- One "Quiz Uploads" container module per section.
--
-- registerQuizUpload find-or-creates this hidden module per ad-hoc upload; two
-- uploads completing concurrently can both see none and both insert
-- (check-then-act race), leaving duplicate hidden modules. The app already
-- treats the title as the module's identity within a section (find-or-create
-- matches on it), so enforce that at the DB layer. The action handles the
-- unique violation by re-selecting the winner's row.
--
-- No RLS change: `modules` already has RLS; this only adds an index.

-- Merge any duplicates the race already created: keep the oldest module per
-- section, move the duplicates' items onto it, then drop the now-empty
-- duplicates. (Matches by title — the same identity rule the app uses.)
with ranked as (
  select id, section_id,
         row_number() over (partition by section_id order by created_at, id) as rn
  from public.modules
  where title = 'Quiz Uploads'
),
keepers as (select section_id, id from ranked where rn = 1),
dupes as (select section_id, id from ranked where rn > 1)
update public.module_items mi
set module_id = k.id
from dupes d
join keepers k on k.section_id = d.section_id
where mi.module_id = d.id;

delete from public.modules m
using (
  select id from (
    select id, row_number() over (partition by section_id order by created_at, id) as rn
    from public.modules
    where title = 'Quiz Uploads'
  ) r
  where r.rn > 1
) d
where m.id = d.id;

create unique index if not exists modules_one_quiz_uploads_per_section
  on public.modules (section_id)
  where title = 'Quiz Uploads';
