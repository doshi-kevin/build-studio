-- Roadmap Part II — node coverage lifecycle, slice 1.
--
-- The new roadmap derives every node status on read instead of storing it
-- (docs/designs/roadmap-mastery/roadmap-engine.md §11 decision 2). Two facts can't be derived
-- from what we already persist, so they're added here:
--
--   1. modules.coverage_state — a professor's explicit "we're not covering this
--      week". Deliberately NOT is_published, which hides the module from
--      students entirely; a skipped module may still be worth leaving up as
--      optional reading (§13.3).
--   2. lc_decks.max_slide — the FURTHEST slide a deck ever reached, as opposed
--      to current_slide, which is the LATEST. A professor who jumps backwards
--      to answer a question would otherwise lower their own coverage (§13.2).
--
-- No new tables, so no new RLS policies: both columns inherit the existing
-- policies on modules and lc_decks.

-- ── 1. Module skip flag ──────────────────────────────────────────────
-- Enum-shaped rather than a boolean so a future 'planned' state doesn't need a
-- second migration + backfill (§18).

ALTER TABLE modules
  ADD COLUMN coverage_state text NOT NULL DEFAULT 'active'
    CHECK (coverage_state IN ('active', 'skipped'));

COMMENT ON COLUMN modules.coverage_state IS
  'Roadmap delivery coverage: ''active'' counts toward the delivery percentage, ''skipped'' is excluded from both numerator and denominator. Not a visibility flag — see is_published for that.';

-- Partial index: the coverage read filters for the rare skipped rows, and
-- ''active'' is the overwhelming default, so only the exceptions are worth indexing.
CREATE INDEX idx_modules_skipped
  ON modules (section_id)
  WHERE coverage_state = 'skipped';

-- ── 2. Deck high-water slide mark ────────────────────────────────────

ALTER TABLE lc_decks
  ADD COLUMN max_slide int NOT NULL DEFAULT 0;

COMMENT ON COLUMN lc_decks.max_slide IS
  'Highest slide index ever reached in this deck (high-water mark). current_slide is the resume position and can move backwards; this only ever increases. Drives roadmap deck-coverage (covered/total).';

-- Existing decks: the best evidence we have of how far a class got is where it
-- left off, so seed the high-water mark from the resume position.
UPDATE lc_decks SET max_slide = current_slide WHERE current_slide > 0;

-- ── 3. Accumulate the high-water mark on every advance ───────────────
--
-- advanceSlide (live-classroom actions.ts) writes lc_rooms.current_slide and
-- this trigger already mirrors it onto the active deck. Extending it here keeps
-- max_slide correct without touching the hot presenter path, and means slide
-- moves made by any other writer are captured too.
--
-- GREATEST so a backwards jump never lowers the mark. The active_deck_id guard
-- is unchanged: a deck SWITCH sets current_slide to the new deck's resume value,
-- which is not a real advance and must not mirror.

CREATE OR REPLACE FUNCTION lc_mirror_current_slide()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.current_slide IS DISTINCT FROM OLD.current_slide
     AND NEW.active_deck_id IS NOT DISTINCT FROM OLD.active_deck_id
     AND NEW.active_deck_id IS NOT NULL THEN
    UPDATE lc_decks
       SET current_slide = NEW.current_slide,
           max_slide     = GREATEST(max_slide, NEW.current_slide)
     WHERE id = NEW.active_deck_id;
  END IF;
  RETURN NEW;
END $$;

-- ── 4. Assessment engagement counts ──────────────────────────────────
--
-- A quiz completes when the whole roster submitted; an assignment when the
-- whole roster is graded (§13.1). That needs DISTINCT student counts per
-- activity, which must be aggregated in Postgres: a section's quiz_attempts
-- runs to thousands of rows, so counting them in JS would silently truncate at
-- PostgREST's implicit 1000-row cap and under-report completion.
--
-- SECURITY INVOKER (the default) on purpose. Only service_role is granted
-- EXECUTE, and service_role already bypasses RLS, so there is no reason to add
-- a definer-rights escalation surface. The quiz tables are RLS-deny-all by
-- design, so this stays a server-only read reached through the
-- ownership/enrollment-verified actions.

CREATE OR REPLACE FUNCTION roadmap_assessment_counts(p_section_id uuid)
RETURNS TABLE (
  kind              text,
  activity_id       uuid,
  started_students  int,
  finished_students int
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT 'quiz'::text,
         q.id,
         count(DISTINCT a.student_id)::int,
         count(DISTINCT a.student_id) FILTER (WHERE a.submitted_at IS NOT NULL)::int
    FROM quizzes q
    LEFT JOIN quiz_attempts a ON a.quiz_id = q.id
   WHERE q.section_id = p_section_id
   GROUP BY q.id
  UNION ALL
  SELECT 'assignment'::text,
         asg.id,
         count(DISTINCT s.student_id) FILTER (WHERE s.status <> 'draft')::int,
         -- 'graded' only. 'returned' means the professor sent the work BACK for
         -- revision (returnSubmission clears graded_at), so counting it here
         -- would read a class that was universally asked to redo the work as
         -- fully graded — the exact opposite of the truth.
         count(DISTINCT s.student_id) FILTER (WHERE s.status = 'graded')::int
    FROM assignments asg
    LEFT JOIN assignment_submissions s ON s.assignment_id = asg.id
   WHERE asg.section_id = p_section_id
   GROUP BY asg.id
$$;

REVOKE ALL ON FUNCTION roadmap_assessment_counts(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION roadmap_assessment_counts(uuid) TO service_role;
