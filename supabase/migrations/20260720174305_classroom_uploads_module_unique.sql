-- One "Classroom Uploads" container module per section.
--
-- When a professor uploads their own file for a live classroom (not picked from
-- an existing module), the file is promoted into a STUDENT-VISIBLE "Classroom
-- Uploads" module so the session shows up under a module on the roadmap
-- (promoteUploadedDeckToModuleMaterial). Like the hidden "Quiz Uploads" module,
-- this is find-or-created per section by title, so two uploads completing
-- concurrently could both insert (check-then-act race) and leave duplicates.
-- Enforce single-instance-per-section at the DB layer; the caller handles the
-- unique violation by re-selecting the winner's row.
--
-- Mirrors modules_one_quiz_uploads_per_section (mig 20260612141203). No RLS
-- change: `modules` already has RLS; this only adds an index.

-- Merge any duplicates a prior race already created: keep the oldest module per
-- section, move the duplicates' items onto it, then drop the empty duplicates.
with ranked as (
  select id, section_id,
         row_number() over (partition by section_id order by created_at, id) as rn
  from public.modules
  where title = 'Classroom Uploads'
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
    where title = 'Classroom Uploads'
  ) r
  where r.rn > 1
) d
where m.id = d.id;

create unique index if not exists modules_one_classroom_uploads_per_section
  on public.modules (section_id)
  where title = 'Classroom Uploads';
