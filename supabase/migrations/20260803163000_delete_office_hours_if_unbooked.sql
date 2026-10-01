-- Atomic guarded delete for office hours (PR #530 / calendar hardening).
--
-- deleteOfficeHours must refuse to delete office hours that still have real (non-cancelled)
-- bookings: the bookings.office_hours_id FK is ON DELETE CASCADE, so a delete would silently
-- wipe students' appointments and history. The previous app-layer "count then delete" was
-- unsafe two ways:
--   1. Fail-open — if the count query errored, the guard was skipped and the delete proceeded.
--   2. TOCTOU  — a booking committed between the count and the delete got cascade-deleted.
--
-- This function does the check and the delete in a single statement: the NOT EXISTS is evaluated
-- in the same snapshot as the DELETE, so a row is removed only if it has no active booking at that
-- instant. Returns true when it deleted, false when a booking blocked it (or the row was already
-- gone). The caller (deleteOfficeHours) still verifies professor ownership before invoking it.
create or replace function delete_office_hours_if_unbooked(p_office_hours_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from office_hours oh
    where oh.id = p_office_hours_id
      and not exists (
        select 1 from bookings b
        where b.office_hours_id = p_office_hours_id
          and b.status <> 'cancelled'
      )
    returning oh.id
  )
  select exists (select 1 from deleted);
$$;

-- Server-only: the caller verifies professor ownership and invokes this via the service-role
-- admin client. Revoke from the client-reachable roles so it can't be abused as an IDOR
-- delete-by-id oracle, then grant EXECUTE back to service_role explicitly — the blanket revoke
-- from public would otherwise strip service_role's inherited grant and break the admin call.
revoke execute on function delete_office_hours_if_unbooked(uuid) from public, anon, authenticated;
grant execute on function delete_office_hours_if_unbooked(uuid) to service_role;
