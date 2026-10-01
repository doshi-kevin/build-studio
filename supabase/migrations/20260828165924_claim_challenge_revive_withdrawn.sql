-- #703 part 1: "Re-claim" was a dead button.
--
-- `claimChallenge` did a plain INSERT and `withdrawClaim` only flipped status to 'withdrawn'. With
-- `UNIQUE (challenge_id, user_id)` the re-insert after a withdrawal ALWAYS collided, so the student
-- got "You have already claimed this challenge" forever with no recovery path.
--
-- ONE STATEMENT, not update-then-insert. The obvious fix is to try an UPDATE on the withdrawn row
-- and fall back to an INSERT, and that is the same read-decide-write race this codebase keeps
-- removing: two parallel calls both find no active row, both insert, and one collides anyway.
-- `insert ... on conflict do update` is resolved atomically by the engine.
--
-- THE `where` ON `do update` IS LOAD-BEARING. An unconditional upsert would let a student overwrite
-- their own APPROVED claim back to 'claimed', silently discarding an awarded review, or wipe a
-- reviewer's rejection note. Only a WITHDRAWN row may be revived. If the existing row is in any
-- other state the update matches nothing, no row is returned, and the caller reports that it is
-- already claimed, which is true.
--
-- The claim timestamp RESETS. Preserving it looks respectful of history and is a trap: deadlines and
-- ordering are computed from the claim time, so a student who withdrew, waited three days, and
-- re-claimed would be locked out instantly by a window that expired while they were withdrawn.
-- The prior review fields are cleared for the same reason: a revived claim has not been reviewed.
--
-- Not `security definer`: the only caller is a server action using the service-role client, which
-- already bypasses RLS, so definer rights would add privilege for nothing. Postgres grants EXECUTE
-- to PUBLIC by default and Supabase exposes functions over PostgREST, so the revoke below is what
-- stops a student calling this directly for an arbitrary user_id.

create or replace function public.claim_challenge(p_challenge_id uuid, p_user_id uuid)
returns table (claim_id uuid, revived boolean)
language sql
set search_path = public
as $$
  insert into public.challenge_claims (challenge_id, user_id, status, claimed_at)
  values (p_challenge_id, p_user_id, 'claimed', now())
  on conflict (challenge_id, user_id) do update
     set status        = 'claimed',
         claimed_at    = now(),
         reviewed_at   = null,
         reviewed_by   = null,
         reviewer_note = null,
         updated_at    = now()
   where challenge_claims.status = 'withdrawn'
  returning challenge_claims.id,
            -- xmax <> 0 means this row came from the DO UPDATE branch rather than the insert, which
            -- is how the caller can tell a revive from a first claim without a second query.
            (xmax <> 0) as revived;
$$;

comment on function public.claim_challenge(uuid, uuid) is
  'Claims a challenge, reviving a WITHDRAWN claim if one exists (#703 part 1). Atomic upsert; the '
  'where clause on DO UPDATE means an approved or rejected claim is never overwritten, and zero '
  'rows returned means "already claimed". Resets claimed_at and clears the prior review. '
  'service_role only: never grant to anon or authenticated.';

revoke all on function public.claim_challenge(uuid, uuid) from public;
revoke all on function public.claim_challenge(uuid, uuid) from anon, authenticated;
grant execute on function public.claim_challenge(uuid, uuid) to service_role;
