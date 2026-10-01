-- feedbacks.admin_notes is staff commentary ABOUT the submitter. The submitter could read it.
--
-- RLS on this table is row-level and correct as far as it goes: "Users can read own
-- feedback" USING (auth.uid() = user_id). But a row-level policy grants the WHOLE row,
-- and admin_notes is a column on that row — so a user reading their own submission over
-- PostgREST got the admin's private notes back with it. Hiding the field in the UI does
-- nothing; the fix has to be a column privilege, which is a separate mechanism from RLS.
--
-- Table-level SELECT was granted to anon and authenticated on every column, so the
-- privilege check never narrowed anything. Replace it with a column list that omits
-- admin_notes, leaving the owner-read policy intact for everything else.
--
-- Safe for the app: every read of this table goes through createAdminClient() (the admin
-- feedback page is the only consumer), and the service role bypasses both RLS and column
-- grants. Nothing in the app reads feedbacks with a user session.
--
-- Also cleaned up while here, both defence-in-depth rather than live holes:
--   * UPDATE was granted to anon and authenticated on all columns. No UPDATE policy
--     exists, so RLS was refusing these anyway — but the grant is surface with no reason
--     to exist, and it covered admin_notes and status.
--   * INSERT was likewise granted on all columns, which would let a submitter pre-set
--     their own admin_notes and status. Re-granted over the submitter-supplied columns
--     only; status keeps its DEFAULT 'new', so omitting it from the grant costs nothing.
--
-- MAINTENANCE NOTE: because SELECT is now column-scoped, a column added to this table in
-- future is NOT readable by `authenticated` until it is added to the grant below. That is
-- the intended failure direction (new columns are private until someone opts them in),
-- but it will look like a mystery permission error if you forget.

revoke select, insert, update on public.feedbacks from anon, authenticated;

grant select (
  id,
  user_id,
  user_role,
  institution_id,
  rating,
  category,
  message,
  page_url,
  page_context,
  status,
  created_at,
  updated_at
) on public.feedbacks to authenticated;

grant insert (
  user_id,
  user_role,
  institution_id,
  rating,
  category,
  message,
  page_url,
  page_context
) on public.feedbacks to authenticated;
