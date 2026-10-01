-- Scholera Pulse — track whether a published quiz's students have been notified.
--
-- Mirrors assignments.publish_notified_at (migration 20260701000000). A quiz can go
-- live three ways —
--   1. inline (publishQuiz), which fans out the notification in the server action;
--   2. autoPublishScheduledQuizzes (page-load), which flips a due scheduled quiz and
--      fans out inline; and
--   3. the schedule_quiz_publish() pg_cron one-time job, which flips a scheduled quiz
--      to 'published' with a direct SQL UPDATE — no server action runs.
--
-- Path 3 previously had NO notification: once pg_cron flipped the quiz to 'published',
-- the page-load path (which claims only status='draft' rows) could never pick it up, so
-- students were never told. publish_notified_at closes that gap the same way it does for
-- assignments:
--   * inline paths (1, 2) stamp it in the SAME update that sets status='published';
--   * the pg_cron scheduled publish (3) leaves it NULL;
--   * the app-layer sweep (/api/notifications/cron) atomically claims every
--     published-but-unnotified row (stamps this column) and fans out — so it only ever
--     picks up the scheduled pg_cron path, never double-notifies an inline publish.
--
-- No RLS change: quizzes already has RLS enabled; this only adds a column.

ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS publish_notified_at timestamptz;

COMMENT ON COLUMN public.quizzes.publish_notified_at IS
  'When enrolled students were notified this quiz went live. NULL while status=published means the notification sweep still owes a notification (e.g. a scheduled pg_cron auto-publish).';

-- The sweep''s claim query filters exactly this predicate; a partial index keeps it
-- cheap as the table grows (it matches only the small, transient unnotified set).
CREATE INDEX IF NOT EXISTS idx_quizzes_publish_unnotified
  ON public.quizzes (updated_at)
  WHERE status = 'published' AND publish_notified_at IS NULL;

-- Backfill: every quiz already published pre-dates this feature, so mark it
-- already-notified. Without this the first sweep would spam every historical row.
-- (quizzes has no published_at column, so fall back to updated_at.)
UPDATE public.quizzes
   SET publish_notified_at = COALESCE(updated_at, now())
 WHERE status = 'published' AND publish_notified_at IS NULL;

-- Force PostgREST to reload its schema cache so the new column is queryable
-- immediately (without this, quiz writes referencing it fail with PGRST204 until the
-- REST server is restarted).
NOTIFY pgrst, 'reload schema';
