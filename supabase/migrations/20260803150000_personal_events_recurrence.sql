-- Recurring personal events — mirrors the blocked_times recurrence model (weekly only, v1).
-- A weekly event repeats on its start weekday from its date through recurrence_until (or the
-- calendar window if open-ended); expansion happens at read time in the student aggregator.

ALTER TABLE public.personal_events
  ADD COLUMN IF NOT EXISTS recurrence text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS recurrence_until date;

-- Defense-in-depth beyond the Zod schema: constrain the supported values and the ordering.
-- Wrapped so the migration is safe to re-run.
DO $$ BEGIN
  ALTER TABLE public.personal_events
    ADD CONSTRAINT personal_events_recurrence_check CHECK (recurrence IN ('none', 'weekly'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.personal_events
    ADD CONSTRAINT personal_events_recurrence_until_check
    CHECK (recurrence_until IS NULL OR recurrence_until >= date);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
