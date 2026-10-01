-- Archive for Athena's roadmap artifacts: a student "removing" a note now
-- parks it in the roadmap's Archive tray instead of destroying it — restore
-- and permanent delete both live there. NULL = on the map (the default for
-- every existing row); a timestamp = archived at that moment.
--
-- No new index: every read is already served by
-- athena_artifacts_section_student_idx and filters archived rows in the app.
-- RLS posture unchanged — the table stays deny-all with admin-client access
-- behind app-layer ownership checks (see 20260804154308_athena_artifacts.sql).

ALTER TABLE athena_artifacts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
