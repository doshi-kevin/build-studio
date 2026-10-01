-- Skill Mastery — "suggested but not yet tracked" state for AI-extracted concepts.
--
-- The AI extractor sometimes surfaces course administration / structure (e.g.
-- "Course Logistics", "References") or one-off concepts that shouldn't be tracked
-- for mastery until corroborated. Rather than silently drop them (professor loses
-- the chance to opt in) or auto-track them (noise), seed such concepts as
-- `suppressed = true`: they live in the pool and show in Curate as a "Suggested"
-- group the professor can promote, but they are NOT scored, NOT shown on the
-- roadmap mastery view, and NOT counted as coverage until promoted.
--
-- Distinct from `excluded` (which means "the professor dropped this"): suppressed
-- means "the system isn't confident yet". The reconcile pass promotes a suppressed
-- concept (suppressed → false) once it's corroborated (appears in ≥2 materials, is
-- activity-linked, or is the section's only source). Promotion-only — reconcile
-- never re-suppresses a tracked skill, so it can't fight the professor's choices.

alter table public.skills
  add column if not exists suppressed boolean not null default false;

-- RLS unchanged: the existing per-section policies already govern this column.
