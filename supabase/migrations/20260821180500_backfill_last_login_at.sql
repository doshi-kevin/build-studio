-- Backfill profiles.last_login_at from auth.users.last_sign_in_at (#731).
--
-- profiles.last_login_at has never been populated for a single account: verified
-- against production, 46 of 46 rows NULL, while 30 of those users have actually
-- signed in and have a correct auth.users.last_sign_in_at (GoTrue maintains that one
-- itself, reliably, for every sign-in method).
--
-- The cause was a routing bug, fixed in the same change: a Next.js server action
-- POSTs to the URL of the page that invoked it, so recordSignIn() posted to /login,
-- where middleware RULE 2 saw the freshly-set auth cookies and 307'd it to /dashboard
-- before the action body ever ran.
--
-- Consequence: src/lib/notifications/re-engagement.ts selects dormant students with
-- `.lt('student.last_login_at', cutoff)`, and in Postgres `NULL < anything` is NULL,
-- not true. Excluding never-tracked students is deliberate and correct behaviour
-- given a working signal -- with the signal permanently NULL it excluded EVERYONE, so
-- the cron has run on schedule since it shipped, found zero candidates every time,
-- and sent nothing. No error, no log line.
--
-- This backfill gives re-engagement real history to work from instead of starting
-- from zero, and makes the "Last login" column in the three admin/team views show a
-- real date instead of a permanent placeholder.
--
-- Data-only and idempotent: re-running it is a no-op, since it only ever copies the
-- authoritative value and only where ours is behind.

UPDATE public.profiles p
SET last_login_at = u.last_sign_in_at
FROM auth.users u
WHERE u.id = p.id
  AND u.last_sign_in_at IS NOT NULL
  AND (p.last_login_at IS NULL OR p.last_login_at < u.last_sign_in_at);
