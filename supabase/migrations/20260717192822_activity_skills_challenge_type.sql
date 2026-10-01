-- Slice A: let challenges feed skill mastery via the shared activity_skills map.
-- Adds 'challenge' to the activity_type whitelist so a challenge can be mapped to
-- skills exactly like quizzes/assignments, and applyGradeToSkillMastery() will
-- fold an approved challenge into skill_mastery. No new table — reuse activity_skills.
alter table public.activity_skills drop constraint if exists activity_skills_activity_type_check;
alter table public.activity_skills
  add constraint activity_skills_activity_type_check
  check (activity_type in ('quiz', 'assignment', 'exam', 'live_quiz', 'challenge'));
