-- Target total question count for an in-flight AI generation run (existing
-- questions at start + requested count); null when idle. Lets a studio that
-- reattaches to a detached run (reload / navigation / fresh tab) show the same
-- determinate "N of M ready" counter and fading placeholder chips as the live
-- stream, instead of an indeterminate "still generating" state.
--
-- Nullable column on the existing, RLS-protected quizzes table — inherits its
-- per-section policies (no new policy needed). Read/written only by the
-- generation route and getQuizGenerationState, both already section-scoped.
alter table quizzes add column generation_total integer;

comment on column quizzes.generation_total is
  'Target total question count while an AI generation run is in flight (existing questions + requested); null when idle.';
