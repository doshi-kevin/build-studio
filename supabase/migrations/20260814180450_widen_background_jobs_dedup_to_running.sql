-- #630 — asking for the same background job twice while the first is IN FLIGHT
-- started a second concurrent job, doubling the cost of the most expensive
-- operation in the product (an ABET alignment run maps every course artifact
-- through an LLM; ~130 candidates on NLP 506).
--
-- Cause: dedup was enforced solely by `uq_background_jobs_pending`, whose
-- predicate was `WHERE status = 'pending'`. The moment the worker claims a job it
-- flips to 'running', the row leaves the index, and the next insert conflicts
-- with nothing. So the guard covered only the narrow window BEFORE work starts —
-- precisely not the window a user is able to trigger by asking again.
--
-- Fix: widen the predicate to cover both in-flight states. This keeps enforcement
-- in the database, where it is atomic: an application-level "is one running?"
-- SELECT would let two concurrent requests both read "none" and both insert.
--
-- Safe against stuck rows: jobs-worker/kick reapAbandonedJobs() moves a 'running'
-- job whose claim has expired AND whose retries are exhausted to 'failed', so a
-- dead row cannot block its subject forever.
--
-- Verified before writing: zero (institution, section, type, subject) groups on
-- prod currently hold more than one pending/running row, so the unique index
-- builds without conflict.

drop index if exists uq_background_jobs_pending;

create unique index if not exists uq_background_jobs_active
  on public.background_jobs (
    institution_id,
    coalesce(section_id, '00000000-0000-0000-0000-000000000000'::uuid),
    type,
    coalesce(subject_key, ''::text)
  )
  where (status in ('pending', 'running'));

comment on index public.uq_background_jobs_active is
  'One in-flight job per (institution, section, type, subject). Covers pending AND running: a pending-only predicate let a second job start as soon as the first was claimed (#630).';
