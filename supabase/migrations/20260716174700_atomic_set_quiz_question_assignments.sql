-- Atomic rewrite of a quiz's question assignments.
--
-- updateQuizQuestions() rewrote assignments as a NON-atomic delete-all +
-- reinsert. If the reinsert failed after the delete committed, the quiz was left
-- with ZERO questions. The real-world trigger: a duplicate question_id in the
-- client-supplied order violated the UNIQUE(quiz_id, question_id) constraint on
-- reinsert — so a studio state glitch could silently wipe a quiz's questions.
--
-- This folds delete + reinsert into ONE function (one transaction): a failed
-- insert rolls the delete back, so the assignment set is all-or-nothing. It also
-- makes the operation correct on its own:
--   * BOLA guard  — only question_ids that are questions IN THIS SECTION are
--                   assigned (join to quiz_questions on section_id).
--   * Dedupe      — keeps the FIRST occurrence of each id (min ordinality).
--   * Positions   — contiguous 0..n-1 in first-occurrence order.
-- Returns the applied ids in position order (for the caller's provenance stamp).
--
-- SECURITY: locked to service_role — the ONLY caller is the updateQuizQuestions
-- server action via the admin client, AFTER it verifies section ownership and
-- that the quiz belongs to the section. NOT granted to authenticated/anon, so it
-- is not reachable from the browser via PostgREST (no direct-call authz hole).
create or replace function public.set_quiz_question_assignments(
  p_section_id uuid,
  p_quiz_id uuid,
  p_question_ids uuid[]
) returns uuid[]
language plpgsql
as $$
declare
  v_applied uuid[];
begin
  delete from public.quiz_question_assignments where quiz_id = p_quiz_id;

  with ins as (
    insert into public.quiz_question_assignments (quiz_id, question_id, position)
    select
      p_quiz_id,
      s.qid,
      (row_number() over (order by s.first_ord) - 1)::int
    from (
      select t.qid, min(t.ord) as first_ord
      from unnest(p_question_ids) with ordinality as t(qid, ord)
      join public.quiz_questions qq
        on qq.id = t.qid and qq.section_id = p_section_id
      group by t.qid
    ) s
    returning question_id, position
  )
  select array_agg(question_id order by position) into v_applied from ins;

  return coalesce(v_applied, array[]::uuid[]);
end;
$$;

-- Supabase's default privileges grant EXECUTE on new public-schema functions to
-- anon + authenticated, so revoking from PUBLIC alone leaves them callable from
-- the browser. Revoke from those roles explicitly, then grant only service_role.
revoke all on function public.set_quiz_question_assignments(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.set_quiz_question_assignments(uuid, uuid, uuid[]) to service_role;
