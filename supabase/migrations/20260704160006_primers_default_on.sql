-- Class Primers (pre-class-audio) enabled by default for every section.
-- Professors can still turn it off per section via Manage Features.

-- 1. Backfill: add 'pre-class-audio' to enabledFeatures on every existing
--    section that doesn't already have it (idempotent).
update course_sections
set settings = jsonb_set(
  coalesce(settings, '{}'::jsonb),
  '{enabledFeatures}',
  coalesce(settings->'enabledFeatures', '[]'::jsonb) || '["pre-class-audio"]'::jsonb
)
where not coalesce(settings->'enabledFeatures', '[]'::jsonb) ? 'pre-class-audio';

-- 2. New sections: replace the legacy settings default (a dead "features"
--    object nothing reads) with enabledFeatures including pre-class-audio.
alter table course_sections
  alter column settings
  set default '{"enabledFeatures": ["pre-class-audio"]}'::jsonb;
