-- #703 part 2: nothing stopped two identical draft challenges being created at once.
--
-- Production held a real instance: two "QA Double Click B18" drafts in CS-101 A, created
-- 4.4 ms apart (19:55:44.420971 and 19:55:44.425348). The dialog ALREADY disables its submit
-- button while pending, and that did not help, because the second click landed before React
-- re-rendered with the button disabled. That is exactly why data-access.md puts the guard for a
-- one-shot action in the database rather than in the UI.
--
-- Key choice: (section_id, created_by, title), restricted to drafts.
--   * created_by is in the key so two professors in one section never block each other.
--   * `where visibility = 'draft'` keeps legitimate reuse working. Publish "Week 1", then create
--     another draft called "Week 1" later and it still succeeds, because the first is no longer a
--     draft. Only an unpublished twin collides.
--   * A genuine double-submit always shares all three, so it always collides.

-- Any pre-existing duplicate is by definition a double-submit artifact: same section, same
-- author, same title, and all still drafts. Keep the earliest of each group and drop the rest,
-- otherwise the index below cannot be built.
--
-- Deliberately refuses to delete anything a student has touched. A draft is not claimable, so
-- this should never match, but if it ever does the index creation fails loudly and a human looks
-- at it, which is the right outcome for destroying earned credit.
delete from public.challenges c
using (
  select id,
         row_number() over (
           partition by section_id, created_by, title
           order by created_at, id
         ) as rn
  from public.challenges
  where visibility = 'draft'
) dupes
where c.id = dupes.id
  and dupes.rn > 1
  and not exists (select 1 from public.challenge_claims cc where cc.challenge_id = c.id)
  and not exists (select 1 from public.certificate_challenges ce where ce.challenge_id = c.id);

create unique index if not exists challenges_no_duplicate_draft
  on public.challenges (section_id, created_by, title)
  where visibility = 'draft';

comment on index public.challenges_no_duplicate_draft is
  'Stops a double-submitted create from making two identical drafts (#703 part 2). Scoped to '
  'drafts so republishing the same title later is still allowed; createChallenge branches on '
  '23505 and reports the existing draft rather than a generic failure.';
