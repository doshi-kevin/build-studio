-- #631 — editing a module's Description did not invalidate the outcome-alignment cache, so
-- re-running the analysis early-aborted with "No changes since the last analysis."
--
-- The cause is worse than a hash that missed a field: the gather step selects only
-- `modules.id`, purely to reach that module's items. A module's own title and description
-- were never map inputs at all, so nothing about them could ever change the content hash.
-- The early-abort was reporting the truth about the inputs it had.
--
-- A module carrying a real description is exactly the artifact a professor edits to improve
-- outcome mapping, so it becomes its own evidence candidate. That needs 'module' to be an
-- allowed evidence_source_type.
--
-- evidence_source_id has no foreign key, so storing a modules.id there is safe.

alter table public.course_outcome_alignments
  drop constraint if exists course_outcome_alignments_evidence_source_type_check;

alter table public.course_outcome_alignments
  add constraint course_outcome_alignments_evidence_source_type_check
  check (evidence_source_type in ('clo', 'assignment', 'quiz', 'module_item', 'module'));

comment on column public.course_outcome_alignments.evidence_source_type is
  'Which artifact this evidence came from. ''module'' is the module itself (its title and '
  'description), distinct from ''module_item'', which is one piece of material inside it. '
  'Added for #631: a module description was invisible to the mapper, so editing it could '
  'never invalidate the analysis cache.';
