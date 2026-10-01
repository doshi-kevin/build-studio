-- ============================================================
-- Cost Analysis ledgers — integrity hardening
-- ============================================================
-- Follow-up to 20260709193444_cost_analysis_ledgers.sql (already applied),
-- addressing consultant diff-review findings:
--
--  1. Monotonic-max guard on external_usage_events cumulative meters. The live
--     Scribe heartbeat upserts one row per session keyed by dedup_key, and the
--     quantity (connected seconds) only ever GROWS within a session. A blind
--     upsert let an out-of-order/late heartbeat — or a hand-crafted POST with a
--     smaller `seconds` — overwrite the row DOWNWARD, silently dropping billed
--     usage. This BEFORE UPDATE trigger keeps the larger value, so a lower
--     re-report is a no-op. Safe for every current upsert use (Scribe seconds
--     grow; Resend email quantity is a constant 1).
--
--  2. Format guard on provider_bill_snapshots.month so 'YYYY-MM' is the only
--     accepted shape — otherwise '2026-06' and '2026/06' both satisfy the
--     unique(provider,month) key and split the month's history across two rows,
--     breaking the reconciliation aggregation.
-- ============================================================

create or replace function public.preserve_max_external_usage()
returns trigger
language plpgsql
as $$
begin
  -- Cumulative meters only grow within a session; never let an upsert lower a
  -- recorded quantity (out-of-order heartbeat or tampered re-report).
  if new.quantity < old.quantity then
    new.quantity := old.quantity;
    new.cost_usd := old.cost_usd;
    new.metadata := old.metadata;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists external_usage_events_preserve_max on public.external_usage_events;
create trigger external_usage_events_preserve_max
  before update on public.external_usage_events
  for each row
  execute function public.preserve_max_external_usage();

alter table public.provider_bill_snapshots
  drop constraint if exists provider_bill_snapshots_month_format_check;
alter table public.provider_bill_snapshots
  add constraint provider_bill_snapshots_month_format_check
  check (month ~ '^\d{4}-\d{2}$');
