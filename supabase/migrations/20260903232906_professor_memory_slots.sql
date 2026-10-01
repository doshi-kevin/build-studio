-- Professor slots for the memory layer.
--
-- `kind` has no check constraint, so the new slot names need nothing here. What
-- does need changing is the partial unique index that enforces "one row per
-- single-value slot": it lists the student slots by name, so without this the
-- professor's replace-on-write slots would silently accept duplicates and the
-- newest write would stop replacing the previous one.
--
-- The professor slots are deliberately separate from the student ones rather
-- than reused. A professor's work spans several modes at once (announcements,
-- quizzes, grading), so a single shared `tone` slot would have them overwriting
-- each other. It also keeps the two surfaces apart for a user who is a teaching
-- assistant in one section and a student in another: each surface reads only its
-- own slots, so neither can see the other's rows.
--
-- No RLS change. The table keeps its owner-only SELECT policy and still has no
-- insert, update or delete policy, so every write continues to go through server
-- code holding the service role.

drop index if exists user_memory_single_slot_unique;

create unique index user_memory_single_slot_unique
  on user_memory (user_id, section_id, kind) nulls not distinct
  where kind in (
    -- student
    'answer_length', 'explanation_style', 'language_level', 'tone',
    -- professor. `workflow` is deliberately absent: it is the catch-all for
    -- standing rules, and two unrelated rules land in it constantly, so it
    -- appends and is capped in application code like the other additive slots.
    'announcement_style', 'quiz_style', 'grading_style'
  );

comment on index user_memory_single_slot_unique is
  'Slots where a new statement REPLACES the old one. Multi-value slots (constraint, context, workflow) are deliberately absent: they append and are capped in application code.';
