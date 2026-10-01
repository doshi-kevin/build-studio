-- The student assistant's feature key becomes 'athena' (athena-students.md §9).
--
-- The surface has been called Athena since the shell shipped; the toggle key was
-- still 'ai-tutor', the name of the retired full-context tutor it replaced. The
-- code constant moves in the same commit (src/lib/course-features.ts), so this
-- migration exists to carry the sections that already have it switched on —
-- without it, every professor who enabled Athena would silently have it off.
--
-- `course_sections.settings` holds the key in up to three independent arrays,
-- and all three must move together (see CLAUDE.md, Feature Toggles):
--   enabledFeatures — what STUDENTS may reach; the gate the route checks.
--   sidebarHidden   — the professor's own nav, features they collapsed away.
--   sidebarOrder    — the professor's own nav ordering.
-- Migrating only the first would resurrect a nav entry the professor had hidden
-- and drop it to the bottom of their sidebar.
--
-- Each statement rewrites the array element-wise, so ordering is preserved and a
-- section carrying neither key is untouched.

update course_sections
set settings = jsonb_set(
      settings,
      '{enabledFeatures}',
      (select jsonb_agg(case when v = '"ai-tutor"'::jsonb then '"athena"'::jsonb else v end)
         from jsonb_array_elements(settings -> 'enabledFeatures') v)
    )
where jsonb_typeof(settings -> 'enabledFeatures') = 'array'
  and settings -> 'enabledFeatures' @> '["ai-tutor"]'::jsonb;

update course_sections
set settings = jsonb_set(
      settings,
      '{sidebarHidden}',
      (select jsonb_agg(case when v = '"ai-tutor"'::jsonb then '"athena"'::jsonb else v end)
         from jsonb_array_elements(settings -> 'sidebarHidden') v)
    )
where jsonb_typeof(settings -> 'sidebarHidden') = 'array'
  and settings -> 'sidebarHidden' @> '["ai-tutor"]'::jsonb;

update course_sections
set settings = jsonb_set(
      settings,
      '{sidebarOrder}',
      (select jsonb_agg(case when v = '"ai-tutor"'::jsonb then '"athena"'::jsonb else v end)
         from jsonb_array_elements(settings -> 'sidebarOrder') v)
    )
where jsonb_typeof(settings -> 'sidebarOrder') = 'array'
  and settings -> 'sidebarOrder' @> '["ai-tutor"]'::jsonb;
