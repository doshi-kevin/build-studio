# Studio Trusted Server Path

The only code allowed to read or write Studio plugin storage, and the rules it applies. Rule numbers cite [studio-plugin-rules.md](./studio-plugin-rules.md), which wins any disagreement. The tables it reaches are in [studio-plugin-storage.md](./studio-plugin-storage.md).

| | |
|---|---|
| **Status** | Complete locally, pending Supabase acceptance (see [Verification](#verification)). No callers yet: no server action exposes it |
| **Owner** | Kevin Dohsi |
| **Date** | 2026-09-30 |
| **Code** | `src/lib/studio/` (`context.ts`, `policy.ts`, `record-schema.ts`, `db.ts`, `records.ts`, `lifecycle.ts`, `publication.ts`) |
| **Tests** | `src/__tests__/studio-{policy,record-schema,records,context,lifecycle,table-access}.test.ts`, and `src/__tests__/db/studio-server-path.test.ts` end to end |

## Why it exists

The database refuses structural mistakes on its own: a cross-institution reference, an unapproved version, a write to an archived installation. It can't decide what a particular viewer may see, because that depends on each collection's access rule in the manifest (rule 3.3). This layer makes that decision, on the server, from the session. A caller can be the Studio UI, the future Scholera Bridge, a test, or any other Scholera code. The layer assumes every caller is hostile.

## Layers

| Layer | Does | Never does |
|---|---|---|
| Server action (none yet) | Calls one service function and returns `{ error }` or `{ success }` | Reads the database. Decides access. Passes a user, role, institution, section, owner or version |
| `context.ts` | Builds the viewer or professor context from the session and the database | Accepts identity from its caller |
| `policy.ts` | Decides role, access rule, operation and state. Pure | Touches the database |
| `record-schema.ts` | Validates data against the manifest collection. Pure | Touches the database |
| `db.ts` | Runs queries. Creates the admin client itself. Pins every record query to an installation and collection | Decides access. Accepts an admin client |
| `records.ts`, `lifecycle.ts` | Run the request flow below, stamp writes, audit | Expose an endpoint. All modules are `import 'server-only'` and none is `'use server'` |
| Database | Tenant and actor guards, approvals, immutability, archived means read-only, revoked client grants | Decide per-viewer visibility |

## The record request flow

A request carries only an installation ID, a collection name, a record ID (for get, update and delete), data (for create and update), and paging (for list). Inputs are strict, so a request that names a user, owner, author, version, institution, section or role is refused before anything runs.

1. Check the input's shape.
2. Read the session user.
3. Load the installation.
4. Resolve the role:
   - **Staff:** `verifySectionAccess` on the installation's own section.
   - **Student:** an enrollment with status `enrolled` or `completed`, and the installation is published to students.
5. Use the installation's **current** version and re-check its manifest. The request never names a version.
6. The collection must be the manifest's own property, so a name like `constructor` can't resolve through the prototype.
7. `decide(role, access, operation, state)`.
8. For writes, validate the data.
9. Query through `db.ts` with the policy's owner filter. Stamps come only from steps 2 to 7.
10. Audit writes.

Every refusal before the database answers, and a record that doesn't match, returns the same message: "This isn't available." A caller can't tell a missing installation or record from one they may not see. Validation failures return field issues, but only after authorization has passed.

Records returned to a caller carry `id`, `data`, `createdAt`, `updatedAt` and `mine`. They carry no user IDs (rule 2.1).

## Access rules

**Staff** means professor, TA or grader. **Own** means filtered to, and for create owned by, the viewer.

| Collection | Operation | Student | Professor | TA | Grader |
|---|---|---|---|---|---|
| `perStudent` | list, get | Own | All | All | All |
| `perStudent` | create, update, delete | Own | Refused | Refused | Refused |
| `shared` | list, get | All | All | All | All |
| `shared` | create, update, delete | Refused | All | All | Refused |
| `staffOnly` | list, get | **Refused** | All | All | All |
| `staffOnly` | create, update, delete | **Refused** | All | All | Refused |

- **Archived installation.** Every create, update and delete is refused for every role. Reads follow the table above.
- **Staff writes** follow `canWriteAsStaff`. Graders are read-only until plugin grading exists.
- **Staff don't write students' `perStudent` records** in V1. Feedback belongs to grading.
- **Students are refused entirely for now.** `publication.ts` returns false for every installation until the publication slice designs how a plugin is published to students (rule 8.6). The table above already covers students, so nothing changes in the policy when that lands.

`src/__tests__/studio-policy.test.ts` holds this table cell by cell, for both installation states: 120 cases.

## Record validation

| Manifest type | Accepted |
|---|---|
| `text` | Any string, empty included, up to the record limit. Stored exactly as sent |
| `number` | A finite number. `NaN` and `Infinity` are refused |
| `boolean` | `true` or `false` |

- **Every declared field is required.** `null` is refused.
- **Undeclared fields are refused**, including names like `studentId`.
- **Data must be a plain object.** Arrays, `null`, strings, numbers, `Date`, `Map` and class instances are refused.
- **Keys are checked on the raw object before Zod.** `z.strictObject` accepts an own `__proto__` key, like the ones `JSON.parse` creates, without reporting it.
- **Size limit.** After validation, the record's JSON must be at most `STUDIO_RECORD_MAX_BYTES` (16 KiB), measured in bytes. Validation runs first, so one huge string fails its own length check before anything is stringified. That matters because server actions accept bodies up to 260 MB.
- **Paging.** A list returns at most `STUDIO_RECORD_PAGE_MAX` (100) records per page.
- **Caching.** Schemas are cached per version and collection. That's safe only because versions never change.

## Lifecycle operations

Every operation requires the signed-in user to be the professor of the section named in the request (`requireProfessor`, rule 8.1). Publishing, installing and archiving a project also require that the professor owns the project, because sharing is deferred. Installation operations require the installation to be in that section. The professor is always the actor passed to the database; a request can't name one.

| Function | Database call |
|---|---|
| `createProject` | `insert` into projects |
| `publishVersion` | `parseManifest` first and returns its issues. Then `insert` into versions, which runs the database's publish checks |
| `installPlugin` | `studio_install_plugin` |
| `approveAndActivateVersion` | `studio_activate_version(..., approve: true)` |
| `rollbackVersion` | `studio_activate_version(..., approve: false)` |
| `archiveInstallation`, `archiveProject` | Guarded `update ... where status = 'active'`. Already archived returns "not available" |

Database refusals become plain sentences: version not higher, breaking collection change, wrong plugin, archived, already installed, duplicate name, unusable version. `db.ts` classifies duplicate-key errors, so constraint names stay inside it.

## Audit

Every successful record write, and every lifecycle operation, calls `logEvent` with `eventCategory: 'studio'`. Record events are `studio.record.create`, `.update` and `.delete`. Their metadata is the installation ID, version ID, collection and record ID only, never the record's contents. Reads, refusals and deletes that matched nothing aren't logged.

## Keeping the admin client honest

The admin client bypasses row-level security, so these rules are what stop new code from reading plugin data directly:

- **Only `db.ts` names a `studio_plugin_*` table**, and only `context.ts`, `records.ts` and `lifecycle.ts` import `db.ts`. `studio-table-access.test.ts` fails otherwise.
- **The service modules are `server-only` and none is `'use server'`**, so none of them is a network endpoint. The same test checks both.
- **Contexts are branded types** that only `context.ts` builds from the session. The public functions take request-shaped input and resolve the context themselves, so no caller passes one in.
- **The database still refuses** cross-tenant, unapproved and archived writes if all of the above fail.

## What this layer deliberately doesn't do yet

| Not yet | Arrives with |
|---|---|
| Server actions or any endpoint | The Studio UI (lifecycle) and the Scholera Bridge (records) |
| Students reaching an installation | The publication slice (rule 8.6) |
| Attempt-pinned versions | Grading. In V1 every write uses, and is stamped with, the current version |
| Per-viewer rate limits | The bridge (rule 10.1) |
| Optional fields, other field types | A later manifest version |
| Entitlement checks for Studio (rule 9.3) | When Studio gets an entitlement key |

## Verification

**Status: complete locally, pending Supabase acceptance.** The items still pending are blocked by the machine these steps were built on, which can't run local Supabase. They are not failures. [studio-supabase-acceptance.md](./studio-supabase-acceptance.md) lists the steps that close them.

**Verified locally**

| What | How |
|---|---|
| Manifest validation | `studio-manifest.test.ts` |
| Policy table, all 120 cells | `studio-policy.test.ts` |
| Manifest to Zod compiler, `__proto__`, size limit | `studio-record-schema.test.ts` |
| Trusted context construction | `studio-context.test.ts` |
| Record service authorization, stamping, audit | `studio-records.test.ts` |
| Lifecycle service | `studio-lifecycle.test.ts` |
| Only `db.ts` names Studio tables; no service module is an endpoint | `studio-table-access.test.ts` |
| PostgreSQL invariants | `db/studio-storage.test.ts` on PGlite |
| The whole path, 12 scenarios: one version in two sections, student isolation, `staffOnly`, staff and grader rules, validation, trusted stamps, upgrade, rollback, archive, audit | `db/studio-server-path.test.ts` on PGlite |

For the end-to-end run on PGlite, a scratch stand-in for `createAdminClient()` translated `db.ts`'s query-builder calls into SQL. So that run proves the service logic and every Postgres rule together. It does **not** prove how real PostgREST interprets those calls. The stand-in isn't committed, because it can't vouch for PostgREST.

**Still pending (needs real Supabase)**

- Applying the migration on real Supabase.
- Real PostgREST behavior for every query in `db.ts`: `.match`, `.is`, `.range`, `.order`, `.maybeSingle`, `.single`, `.rpc`, and select and returning column lists.
- Generated Supabase TypeScript types for the Studio tables.
- Supabase security and performance advisors.
