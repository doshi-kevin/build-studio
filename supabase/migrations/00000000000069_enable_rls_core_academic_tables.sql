-- Enable RLS on the 10 core academic tables to close a prod/migrations drift.
--
-- These are the oldest tables (created in 00000000000000_base_schema.sql). On
-- PROD, row-level security was enabled on them directly (outside migrations),
-- so prod is locked down. But the ENABLE ROW LEVEL SECURITY statements were
-- never written back as a migration. As a result, every database built purely
-- from migrations — staging, each intern's local `db reset`, and CI's test DB —
-- came up with RLS OFF on these tables, leaving them fully readable/writable
-- with the public anon key (which ships in the browser bundle).
--
-- Note the SELECT policies for course_sections and enrollments already exist
-- (migrations 32 / 33 / 33b) — but with RLS disabled they were inert. Enabling
-- RLS here makes those policies enforced. The other 8 tables intentionally have
-- NO policy: with RLS on that is deny-all to the anon/authenticated roles, and
-- the app reads/writes them server-side via the service_role admin client
-- (createAdminClient) — matching how prod already behaves.
--
-- Idempotent: `enable row level security` is a no-op when already enabled, so
-- this is safe to apply to prod (already in this exact state) and to any fresh
-- from-migrations database.

alter table public.courses             enable row level security;
alter table public.course_sections    enable row level security;
alter table public.departments         enable row level security;
alter table public.department_faculty  enable row level security;
alter table public.programs            enable row level security;
alter table public.modules             enable row level security;
alter table public.module_items        enable row level security;
alter table public.announcements       enable row level security;
alter table public.events              enable row level security;
alter table public.enrollments         enable row level security;
