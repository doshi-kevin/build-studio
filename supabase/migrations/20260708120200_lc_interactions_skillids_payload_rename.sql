-- Live Classroom v1→v2 cutover, part 3: fix the live-quiz skill-tag field name.
--
-- Live-quiz payloads store each question's skill tags under `topicIds`, but the
-- mastery recompute reads `skillIds` (the topics→skills rename renamed the reader
-- but not the payload field). Result: per-question tags were silently ignored and
-- live-quiz mastery always fell back to fuzzy title name-matching. The code is
-- being standardised on `skillIds`; migrate any existing payloads to match.
--
-- Idempotent: only rewrites quiz interactions whose questions still carry
-- `topicIds`; renames the key to `skillIds` (preserving the value) per question.

update public.lc_interactions
set payload = jsonb_set(
  payload,
  '{questions}',
  (
    select jsonb_agg(
      case
        when q ? 'topicIds' then (q - 'topicIds') || jsonb_build_object('skillIds', q->'topicIds')
        else q
      end
      order by ord
    )
    from jsonb_array_elements(payload->'questions') with ordinality as t(q, ord)
  )
)
where kind = 'quiz'
  and jsonb_typeof(payload->'questions') = 'array'
  and exists (
    select 1 from jsonb_array_elements(payload->'questions') q where q ? 'topicIds'
  );
