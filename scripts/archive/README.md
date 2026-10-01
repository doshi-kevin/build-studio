# Archived scripts

One-off scripts whose job is done. They are kept for audit trail and for the rare
re-run, not as live tooling — nothing in `package.json`, CI, or `infra/` calls them.
Live operational scripts stay in `scripts/` and `scripts/dev-setup/`.

| Script | Why it's here |
|---|---|
| `apply-mig-59-bucket-size.ts` | Applied migration 59 (deck bucket size limit) to prod. Shipped. |
| `migrate-planning-to-docs.ts` | Moved planning artifacts into `docs/`. Done once. |
| `migrate-ss-data.ts`, `migrate-ss-phase0.ts`, `migrate-ss-shared.ts`, `validate-migration.ts`, `remap-professor.ts`, `send-invites.ts` | The SkillSignal (Railway → Supabase) data migration set. Completed; retained because the mapping and validation logic is the record of what moved. They cross-import `./migrate-ss-shared`, so they move as a group. |
| `test-adaptive-engine.ts`, `test-adaptive-integration.ts`, `test-adaptive-validations.ts` | Ad-hoc harnesses for the ELO adaptive-quiz engine, which was wired out for IP reasons. The live adaptive path is CCAT v2, covered by the Vitest suite. |
