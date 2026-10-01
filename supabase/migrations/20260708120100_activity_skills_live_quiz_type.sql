-- Live Classroom v1→v2 cutover, part 2: make live quizzes a first-class skill
-- coverage source.
--
-- activity_skills mapped only ('quiz','assignment','exam'), so live-classroom
-- quizzes never appeared in the coverage lens/matrix even though they can carry
-- skill tags. Add a 'live_quiz' activity_type; the reconcile pass will populate
-- these rows from each live quiz's per-question skill tags + its room's linked
-- module (deck → module inheritance), so coverage and the mastery recompute read
-- ONE source, symmetric with quizzes/assignments.
--
-- activity_id for a 'live_quiz' row is the lc_interactions.id of the quiz.
-- Data-preserving DROP/ADD (no table recreate).

alter table public.activity_skills drop constraint if exists activity_skills_activity_type_check;
alter table public.activity_skills
  add constraint activity_skills_activity_type_check
  check (activity_type in ('quiz', 'assignment', 'exam', 'live_quiz'));
