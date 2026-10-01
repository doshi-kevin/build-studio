-- Assignments enabled by default for every section.
-- Professors can still turn it off per section via Manage Features.

-- 1. Backfill: turn assignments on for sections that have NEVER had a feature list
--    curated (enabledFeatures absent). Idempotent.
--
--    Deliberately scoped to `enabledFeatures IS NULL` rather than "the array lacks
--    'assignments'": once the key exists, its contents are the professor's choice, and an
--    absent 'assignments' there means they turned it off (or never turned it on) via Manage
--    Features. CLAUDE.md's Feature Toggles rule makes that toggle authoritative, and this
--    UPDATE is not reversible — after it runs there is no record of which sections had it off.
--    New sections get assignments from the column default below plus
--    DEFAULT_ENABLED_FEATURES (`enabledByDefault: true` in src/lib/course-features.ts), so
--    the feature is still on-by-default going forward.
update course_sections
set settings = jsonb_set(
  coalesce(settings, '{}'::jsonb),
  '{enabledFeatures}',
  coalesce(settings->'enabledFeatures', '[]'::jsonb) || '["assignments"]'::jsonb
)
where settings->'enabledFeatures' is null;

-- 2. New sections: extend the settings default so raw inserts (without the
--    app-level DEFAULT_ENABLED_FEATURES seed) also get assignments on.
alter table course_sections
  alter column settings
  set default '{"enabledFeatures": ["pre-class-audio", "assignments"]}'::jsonb;
