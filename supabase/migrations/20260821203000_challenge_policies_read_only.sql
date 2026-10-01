-- Make the challenge student policies READ-ONLY, closing a client write hole.
--
-- Found in security review of the #700/#701 fixes, and it bounded both of them.
--
-- `FOR ALL` with a USING clause and NO WITH CHECK makes Postgres reuse USING as the
-- INSERT/UPDATE check. Supabase grants DML to `authenticated` by default, so a student
-- could write the table DIRECTLY from the browser with the anon key, as long as the row
-- pointed at their own claim. That bypasses:
--
--   * submitSolutionSchema — so the javascript:-scheme refine added for #700 never runs,
--   * the compare-and-set claim transition added for #701 — so any number of submissions
--     can be attached to one claim, which is the exact invariant #701 establishes, and
--   * every ownership and status check in the server actions.
--
-- This is the failure mode `.claude/rules/security-migrations.md` describes under
-- "Policy command scope — FOR ALL is a write hole", citing PR #198. The rule's remedy is
-- the one applied here: **if there is no client write path, make the policy SELECT-only.**
--
-- There is no client write path. Verified by grep across src/: every write to either
-- table goes through a server action on the ADMIN client (7 sites in the student actions,
-- 2 in the professor actions, 0 via the user client). Client components only ever read
-- them, as embedded relations on server-fetched data. Reads keep a policy because
-- `queries.ts` takes a caller-supplied SupabaseClient and some paths pass the user client.
--
-- ── Only challenge_submissions is still open ────────────────────────────────────
-- An earlier draft of this migration also rewrote challenge_claims, on the strength of a
-- production reading that was already out of date when it was taken. Re-checked against
-- production: challenge_claims was fixed on 2026-06-26 by
-- `20260626184930_security_audit_remediation.sql` (M1), which replaced the FOR ALL policy
-- with a SELECT-only one named "Students read own claims". Prod carries that policy today.
--
-- So claims are NOT rewritten here. Creating the same rule under a second name would leave
-- two identical permissive SELECT policies OR'd together forever, and whichever one a
-- later migration tightened, the other would still let the row through. The legacy FOR ALL
-- name is dropped defensively below because a local or staging database restored from
-- before June still carries it — on production that DROP is a no-op.
--
-- challenge_submissions was missed by that pass and is still `[ALL] with_check = NULL` on
-- production. That is the hole this migration actually closes.
--
-- To be exact about impact: there was NO live XSS. Both render sites are guarded with
-- safeExternalUrl in the same change and a sweep found no third consumer of
-- challenge_submissions.url. What this fixes is that the schema refine and the CAS were
-- decorative against a determined caller — the render guards were doing all the work.
--
-- Every CREATE below is preceded by a DROP IF EXISTS of its OWN name, so the migration is
-- re-runnable. Without that, a second run halts on 42710 and silently skips everything
-- after it in the same file.

BEGIN;

-- ── challenge_submissions: the write hole, closed ───────────────────────────────
DROP POLICY IF EXISTS "Students can manage own submissions" ON public.challenge_submissions;
DROP POLICY IF EXISTS "Students read own submissions"       ON public.challenge_submissions;
CREATE POLICY "Students read own submissions"
  ON public.challenge_submissions FOR SELECT TO authenticated
  USING (
    claim_id IN (
      SELECT id FROM public.challenge_claims WHERE user_id = (select auth.uid())
    )
  );

-- ── challenge_claims: already read-only since 20260626184930; keep it that way ──
-- No-op on production. Real on any database restored from before that migration.
DROP POLICY IF EXISTS "Students can manage own claims" ON public.challenge_claims;
DROP POLICY IF EXISTS "Students read own claims"       ON public.challenge_claims;
CREATE POLICY "Students read own claims"
  ON public.challenge_claims FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

COMMIT;
