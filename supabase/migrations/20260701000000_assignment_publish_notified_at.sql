-- Scholera Pulse — track whether a published assignment's students have been notified.
--
-- Why: an assignment can go live two ways —
--   1. inline (createAssignment publish-now / setAssignmentStatus draft→publish),
--      which fans out the notification in the server action; and
--   2. the publish_scheduled_assignments() pg_cron job, which flips a scheduled
--      assignment to 'published' with a direct SQL UPDATE — no server action runs,
--      so nothing notifies.
--
-- publish_notified_at is the single "students have been told" marker:
--   * inline paths stamp it in the SAME update that sets status='published';
--   * the pg_cron scheduled publish leaves it NULL;
--   * the app-layer sweep (/api/notifications/cron) atomically claims every
--     published-but-unnotified row (stamps this column) and fans out — so it only
--     ever picks up the scheduled path, never double-notifies an inline publish.
--
-- No RLS change: assignments already has RLS enabled; this only adds a column.

ALTER TABLE public.assignments
  ADD COLUMN IF NOT EXISTS publish_notified_at timestamptz;

COMMENT ON COLUMN public.assignments.publish_notified_at IS
  'When enrolled students were notified this assignment went live. NULL while status=published means the notification sweep still owes a notification (e.g. a scheduled auto-publish).';

-- The sweep''s claim query filters exactly this predicate; a partial index keeps it
-- cheap as the table grows (it matches only the small, transient unnotified set).
CREATE INDEX IF NOT EXISTS idx_assignments_publish_unnotified
  ON public.assignments (published_at)
  WHERE status = 'published' AND publish_notified_at IS NULL;

-- Backfill: every assignment already published pre-dates this feature, so mark it
-- already-notified. Without this the first sweep would spam every historical row.
UPDATE public.assignments
   SET publish_notified_at = COALESCE(published_at, now())
 WHERE status = 'published' AND publish_notified_at IS NULL;
