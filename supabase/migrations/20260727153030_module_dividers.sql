-- Module-level dividers: a labelled break between MODULES in a section, the
-- sibling of the in-module `section_divider` module_item. The professor adds
-- them from the Modules page ("New module" split button) and they render as a
-- divider annotation on the roadmap, between module bands.
--
-- `position` shares the scale with modules.position: the Modules page reorders
-- modules and dividers as ONE list and rewrites both tables with 0..n-1, so
-- interleaving is just a sort by position across the two.
--
-- RLS: enabled with NO policy, deliberately — same posture as `modules` /
-- `module_items` (migration 69). With RLS on and no policy this is deny-all to
-- the anon/authenticated roles (the keys that ship in the browser); every read
-- and write goes through the service_role admin client in a server action that
-- has already verified section ownership (or, for students, enrollment).

CREATE TABLE module_dividers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  section_id UUID NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read is "this section's dividers, in order".
CREATE INDEX idx_module_dividers_section_position ON module_dividers(section_id, position);
CREATE INDEX idx_module_dividers_institution ON module_dividers(institution_id);

ALTER TABLE module_dividers ENABLE ROW LEVEL SECURITY;
