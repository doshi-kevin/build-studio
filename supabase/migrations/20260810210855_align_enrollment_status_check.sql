-- enrollments.status: make the DB constraint match ENROLLMENT_STATUSES.
--
-- src/lib/validations/enrollment.ts declares its list as "matching the DB CHECK
-- constraint" — it did not. The app, and the admin's status dropdown, offer 'withdrawn';
-- the constraint never allowed it, so setting a student to Withdrawn passed Zod and then
-- violated the CHECK, surfacing as a generic failure. Same class as the module_items
-- 'image' drift fixed in 20260810202904.
--
-- 'waitlisted' is dropped in the same breath: it appears nowhere in the application, and
-- no row carries it (verified 0 before applying). Keeping it would leave the database able
-- to store a value the app cannot represent — the exact asymmetry that produced this bug.
-- Narrowing is only safe because that count is zero; re-check before assuming so again.
--
-- docs/archive/schema.sql carried a THIRD version of this list ('active','inactive','dropped',
-- 'completed') and is corrected alongside, so nothing re-seeds a fourth variant.

alter table enrollments
  drop constraint if exists enrollments_status_check;

alter table enrollments
  add constraint enrollments_status_check
  check (status = any (array[
    'enrolled',
    'completed',
    'dropped',
    'withdrawn'
  ]));
