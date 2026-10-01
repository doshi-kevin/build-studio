-- Topic Mastery — per-topic include/exclude flag.
--
-- The Topics modal lets a professor uncheck a topic to DROP it from mastery
-- tracking without deleting the row. Soft-exclude (vs hard delete) means:
--   • re-checking restores it, and
--   • auto-populate (module-upload extraction → pool) won't keep re-adding a
--     topic the professor deliberately dropped — the excluded row stays in the
--     pool and the de-dup in reconcile matches against it.
--
-- Existing rows default to included (excluded = false). RLS is already enabled
-- on `topics` (created with the table) and is unaffected by adding a column.

alter table public.topics
  add column if not exists excluded boolean not null default false;
