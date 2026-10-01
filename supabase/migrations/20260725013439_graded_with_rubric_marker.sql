-- Distinguish "graded with the rubric" from "graded before the rubric existed" (PR #469 review).
--
-- rubric_scores is NOT NULL DEFAULT '[]', so an empty array is ambiguous: it means BOTH
-- "manually graded before any rubric existed" AND "rubric-graded with zero criteria ticked".
-- The grader's "Graded by old rubric" badge keyed off that emptiness, so a genuine rubric 0
-- could never clear the badge (the student was re-surfaced in Needs grading forever), and a
-- zero-criteria rubric stranded every graded student.
--
-- graded_with_rubric is set by gradeSubmission whenever a rubric existed at grading time
-- (regardless of how many criteria were ticked). Backfill: any row with ticked criteria was
-- by definition rubric-graded. Additive + idempotent; new column rides the table's existing
-- row RLS (admin-client writes only), so no policy change.
alter table public.assignment_submissions
  add column if not exists graded_with_rubric boolean not null default false;

comment on column public.assignment_submissions.graded_with_rubric is
  'True when the grade was saved while the assignment had a rubric (even with zero criteria ticked). False = manually graded (no rubric at grading time).';

-- jsonb_typeof guards against a drifted row holding an object instead of an array
-- (jsonb_array_length would raise 22023 and abort the migration). The graded_with_rubric
-- predicate makes a re-run a no-op instead of rewriting every row again.
update public.assignment_submissions
  set graded_with_rubric = true
  where graded_with_rubric = false
    and jsonb_typeof(rubric_scores) = 'array'
    and jsonb_array_length(rubric_scores) > 0;
