-- The add/drop policy columns issue #159 designed, which were never actually created.
--
-- src/lib/validations/institution.ts reads `allow_student_drop` and
-- `add_drop_deadline_days`, names an `institutions_add_drop_deadline_days_check` constraint
-- in a comment, and supabase/types.ts declares both. No migration in this repo creates
-- either, and neither exists in production. That is why addDropDeadline() had zero callers:
-- it could not have worked.
--
-- Found while preparing QA for #744, which wires student self-drop onto this policy. Without
-- these columns the select itself errors and self-drop breaks for everyone.
--
-- Defaults are deliberately PERMISSIVE, matching parseAddDropPolicy's documented intent:
-- self-drop allowed, no deadline, which is the behaviour that shipped before any policy
-- existed. An institution opts into a stricter window by setting a day count.

alter table public.institutions
  add column if not exists allow_student_drop boolean not null default true;

alter table public.institutions
  add column if not exists add_drop_deadline_days integer;

comment on column public.institutions.allow_student_drop is
  'Master switch for STUDENT self-drop. Admin-initiated unenroll is a separate flow and is '
  'never gated by this. Default true = the pre-policy behaviour.';

comment on column public.institutions.add_drop_deadline_days is
  'Days after a section''s start_date during which a student may self-drop. NULL means no '
  'deadline: self-drop stays open for the whole term. Anchored to the SECTION, not to each '
  'student''s own enrolment date, so everyone in a course shares one deadline (#744).';

-- 365 is the bound src/lib/validations/institution.ts enforces as
-- MAX_ADD_DROP_DEADLINE_DAYS, and the constraint name its comment already refers to.
alter table public.institutions
  drop constraint if exists institutions_add_drop_deadline_days_check;

alter table public.institutions
  add constraint institutions_add_drop_deadline_days_check
  check (add_drop_deadline_days is null or (add_drop_deadline_days >= 0 and add_drop_deadline_days <= 365));
