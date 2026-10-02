# Studio Plugin Storage

How Studio stores plugins and their data. Rule numbers cite [studio-plugin-rules.md](./studio-plugin-rules.md), which wins any disagreement. The manifest fields cited here are defined in [studio-plugin-manifest.md](./studio-plugin-manifest.md).

| | |
|---|---|
| **Status** | Complete locally, pending Supabase acceptance (see [Verification](#verification)) |
| **Owner** | Kevin Dohsi |
| **Date** | 2026-09-30 |
| **Migration** | `supabase/migrations/20260930175948_studio_plugin_storage.sql`, `20261001181829_studio_publication.sql` (student visibility, storage quota, kill switch; Step 5B), `20261001192059_studio_student_quota.sql` (per-student quota, limits as settings; Step 5C) and `20261002160000_studio_builder.sql` (draft snapshots, builder runs and steps; Step 7B) |
| **Tests** | `src/__tests__/db/studio-storage.test.ts` and `src/__tests__/db/studio-publication.test.ts` (`npm run test:db`) |

## The model

Project, then version, then installation, then approval, then record.

| Concept | Table | What it is |
|---|---|---|
| Project | `studio_plugin_projects` | Reusable plugin source, owned by one professor in one institution. Points at its current draft snapshot (`draft_head_hash`, moved by compare-and-swap on `draft_rev`) and at the one before the last build (`draft_undo_hash`, what Undo goes back to) |
| Version | `studio_plugin_versions` | One immutable published release: semantic version, manifest, frozen source, one compiled bundle per view |
| Installation | `studio_plugin_installations` | One project attached to exactly one course section, pointing at its current version |
| Approval | `studio_plugin_approvals` | Permission for one installation to activate one version. Kept forever as history |
| Record | `studio_plugin_records` | Plugin data. Belongs to one installation, never to a version |
| Usage | `studio_plugin_usage` | One row per installation: how many records and bytes it stores, kept exact by a trigger (Step 5B) |
| Student usage | `studio_plugin_student_usage` | One row per student per installation: their own `perStudent` records and bytes (Step 5C) |
| Limits | `studio_plugin_limits` | One settings row: the installation and per-student storage limits the trigger enforces (Step 5C) |

An installation also carries `student_visibility` (`hidden` or `visible`), which says whether the section's students may open it. That, and the storage quota, are described in [studio-plugin-publication.md](./studio-plugin-publication.md).

One version can be installed in many sections. Each installation has its own approvals and its own records, and no installation can read another's (rule 2.4).

Collections are not tables. A record's `collection` column names a collection its version's manifest declares. Drafts are immutable snapshots in `studio_plugin_snapshots`, written by the builder, and a version saved from one records it in `source_snapshot_hash` (Step 7B, [studio-agent-harness.md](./studio-agent-harness.md)). There is no table for an installation's version history (its approval rows are that history), or for audit (`logEvent` covers it).

## Security model

- **Server-only.** Row-level security is on for all eight tables with no client policies, and every client grant is revoked. Only the service role reaches them. This is the documented exception in `.claude/rules/security-migrations.md`.
- **The trusted server decides who sees what.** It resolves the viewer's role in the section, picks the version, and applies each collection's access rule from the manifest (rule 3.3). A record doesn't store its own visibility. That layer is described in [studio-plugin-server.md](./studio-plugin-server.md).
- **Authoritative IDs come from server or database state, never plugin input.** Institution, section, installation, version, author and owner are filled in by the server from what it loaded. The plugin supplies none of them (rule 2.1).
- **The database is the second line of defense.** It refuses these on its own, whatever the server code does:

| Refused by the database | How |
|---|---|
| An installation in another institution's section | Installation guard trigger |
| A project, version, installation or approval whose actor (`owner_id`, `published_by`, `installed_by`, `approved_by`, `archived_by`) is in another institution | Guard triggers |
| A project, installation or record moving to another institution, section or project after creation | Guard triggers |
| A version from another project | Composite foreign keys on `(version, project)` |
| Activating a version this installation never approved | Foreign key from the installation's current version to its approvals, checked at commit |
| A record under a version this installation never approved | Foreign key from `(installation, version)` to approvals |
| A record stamped with a different section or institution than its installation | Records guard trigger |
| A record in a collection its version doesn't declare, or a `perStudent` record whose owner isn't enrolled in that section | Records guard trigger |
| Any write to an archived installation | Records guard trigger, and `studio_activate_version` |
| A new installation that starts visible to students, or an archived one becoming visible | Installation guard trigger, and `studio_set_student_visibility` |
| A visibility change by someone outside the institution, or naming another section | Installation guard trigger, and `studio_set_student_visibility` |
| A version with an empty student or professor bundle | `studio_plugin_versions_bundles_not_empty` check |
| A record write past its installation's limits, or past its student's own allowance, even from concurrent requests | Usage trigger: conditional updates under row locks, in the write's own transaction, reading `studio_plugin_limits` (and refusing every write if that row is missing) |
| Changing a published version or an approval | Update-refusing trigger |
| Any client read, write or function call | Revoked grants and revoked function execute |

## Upgrade model

- **Published versions are immutable** (rule 8.4).
- **Activating a version needs an approval for that installation** (rules 1.5, 8.2). V1 approval covers the whole plugin card; there is no partial approval.
- **Rollback reuses historical approvals.** Moving back to an approved version is one step (rule 8.5). Other installations of the same project are unaffected.
- **Records never move.** An upgrade or rollback changes one pointer, the installation's current version. Each record keeps the version that wrote it.
- **Only compatible versions can be published in V1.** Every collection the previous version declared must stay identical. That's why moving between versions can't strand a record. Breaking collection changes are refused at publish, not migrated.

## Lifecycle operations

Only operations that need more than one statement are functions. They are not an authorization boundary. The server action calls them after `getAuthUser` and `verifySectionAccess` with the professor role (rule 8.1), and passes the verified user as the actor.

| Operation | How |
|---|---|
| Create project | `insert` into projects |
| Publish | `insert` into versions. The insert trigger checks the version is higher, the manifest `id` matches, the project is active, and collections are compatible |
| Install | `studio_install_plugin(section, version, actor)` writes the installation and its first approval together |
| Approve and upgrade | `studio_activate_version(installation, version, actor, true)` |
| Roll back | `studio_activate_version(installation, version, actor, false)`, which needs an existing approval |
| Archive an installation | `update ... set status = 'archived' ... where status = 'active'`. Its records stay readable and accept no writes |
| Archive a project | `update ... set status = 'archived'`. It can't publish or be installed again; running installations keep working |

## Deferred: not part of Step 2

| Deferred | Why it waits |
|---|---|
| Plugin attempts | Manifest v1 can't declare them. They arrive with grading, together with the rule-8.4 pinning they enable |
| Grading | Its own slice (rules 5.x) |
| Breaking collection changes | Need a decision on existing records and on students mid-attempt |
| Record size limit | Done: 16 KiB per record (Step 3B), per installation (Step 5B) and per student (Step 5C) |
| Field-level validation of `data` against the manifest | Done in the server layer (Step 3B, `record-schema.ts`). The database only checks that `data` is an object and the collection is declared |
| Permanent project deletion | Versions can't be deleted while approvals reference them, so a project with installations can't be deleted yet |
| Partial capability approval | Needs a denied-capability column and plugins that handle refusal |
| Reactivating an archived installation | No operation exists. Don't add one without re-running the install checks |

## Verification

**Status: complete locally, pending Supabase acceptance.** The remaining steps are in [studio-supabase-acceptance.md](./studio-supabase-acceptance.md). They are blocked by this machine, not failing: it can't run local Supabase.

- **Verified on PGlite (real Postgres, in WebAssembly):** the migration applies unchanged, and all 20 tests in `studio-storage.test.ts` pass. The five parent tables it references were stubbed, with Supabase's default client grants. Mutation checks confirmed that removing the approval key, the grant revokes, or the actor and institution guards each makes its own test fail.
- **Pending on real Supabase:** applying the migration alongside every other migration and its event triggers, `npm run test:db`, regenerating `types.ts`, and the database advisors.
- **Failures that predate Studio** (unit suite, 2026-09-30, unchanged by any Studio step):
  - `migration-guards`: `lc_auto_end_stale_rooms()` in `20260925220017_lc_auto_end_from_started_at.sql` never revokes public execute.
  - `ai-call-site-coverage`, `asset-crop`, `chat-attachment-purge`, `lc-scheduling`, `pdf-tables-fixtures` and `test-suite-standards`: Windows path handling in the tests themselves.
