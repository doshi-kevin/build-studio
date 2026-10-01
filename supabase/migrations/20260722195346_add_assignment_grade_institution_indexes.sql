-- Index the institution_id FK on the new assignment/grade tables from this branch.
-- Postgres does not auto-index FK columns; these tables grow per-tenant and institution_id is
-- used for tenant-scoped cleanup and cross-table work. grading_schemes already has one
-- (idx_grading_schemes_institution), so it's omitted. Index-only: additive + idempotent, no RLS
-- change (the tables and their policies were created in their own earlier migrations).

create index if not exists idx_assignment_regrade_requests_institution
  on public.assignment_regrade_requests (institution_id);

create index if not exists idx_assignment_submission_comments_institution
  on public.assignment_submission_comments (institution_id);

create index if not exists idx_assignment_proctoring_logs_institution
  on public.assignment_proctoring_logs (institution_id);

create index if not exists idx_assignment_proctoring_snapshots_institution
  on public.assignment_proctoring_snapshots (institution_id);

create index if not exists idx_grade_categories_institution
  on public.grade_categories (institution_id);

create index if not exists idx_grade_category_items_institution
  on public.grade_category_items (institution_id);

create index if not exists idx_grade_exceptions_institution
  on public.grade_exceptions (institution_id);
