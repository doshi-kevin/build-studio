# Studio Plugin Publication and Student Access

How a professor shows an installed plugin to a section's students, and everything that decides whether a student can then use it. Rule numbers cite [studio-plugin-rules.md](./studio-plugin-rules.md), which wins any disagreement.

| | |
|---|---|
| **Status** | Built locally (Steps 5B and 5C). **Student access is off in production** behind `STUDIO_STUDENT_ACCESS` until every item in [Release gate](#release-gate) passes. Showing a plugin needs a passed verdict from the pre-publish validator (Step 6). Its browser stage has no production runner, so in production nothing can pass yet |
| **Owner** | Kevin Dohsi |
| **Date** | 2026-10-01 |
| **Code** | `src/lib/studio/` (`access.ts`, `publication.ts`, `prepublish.ts`, `student-visibility.ts`, `plugin-card.ts`, `navigation.ts`, `bridge/status.ts`); migrations `20261001181829_studio_publication.sql` and `20261001192059_studio_student_quota.sql`; the student route `src/app/(dashboard)/student/courses/[sectionId]/tools/[installationId]/page.tsx`; the professor's actions next to `studio/[installationId]/page.tsx`; `src/components/studio/publication/`; the kill switch on `/super-admin/ai-controls` |
| **Tests** | `src/__tests__/studio-{access,student-visibility,publication-actions,publication-ui,plugin-card,context,lifecycle,runtime-host,runtime-page,bridge}.test.ts(x)`, `src/__tests__/db/studio-publication.test.ts`, the "losing access" block of `e2e/studio-runtime/isolation.spec.ts`, and the walkthrough `e2e/visual/studio-publication.md` |

## Two things called "published"

| Concept | Where | Means | Changed by |
|---|---|---|---|
| **Version publication** | A row in `studio_plugin_versions` | A frozen code release exists (rule 8.4). Only its owner's Studio sees it | The project owner, by publishing |
| **Approval** | `studio_plugin_approvals` | This installation accepted this version's plugin card (rule 8.2) | The section's professor, by installing or upgrading |
| **Installation status** | `studio_plugin_installations.status` | `active`, or `archived` (read-only history) | The section's professor |
| **Student visibility** | `studio_plugin_installations.student_visibility` | The section's students may open this installation | The section's professor, through `student-visibility.ts` |

Visibility always applies to the installation's **current** version, which is always approved: the storage migration's deferred key makes a current version without an approval impossible. There is no `scheduled` or `paused` state. Neither has a V1 use, and the cases a pause would cover are already computed (see [Who may write](#who-may-write)).

| Status | Visibility | Students |
|---|---|---|
| active | hidden | Nothing. No tab; the URL is not found |
| active | visible | A tab; the plugin works, subject to [who may write](#who-may-write) |
| archived | visible | No tab. A student who could see it keeps read-only access to their history at its URL |
| archived | hidden | Nothing |

## `student_visibility`

- **Values:** `hidden` (the default) or `visible`, checked by the database. A new installation can't be inserted as `visible`.
- **One write path:** `studio_set_student_visibility(installation, section, visibility, actor)`. It locks the row, refuses an installation from another section, refuses `visible` unless the installation is `active`, and returns whether anything changed. The installation guard trigger refuses the same transition on any direct update.
- **Who:** the section's professor only (`requireProfessor`). Not TAs, graders or admins. The database function is not an authorization boundary; like every Studio function it trusts the server that calls it, and checks the actor is in the installation's institution.
- **History:** `visibility_changed_at` and `visibility_changed_by` on the row, plus the event log. No separate history table: nothing depends on past visibility.
- **Archiving** keeps visibility as it was. An archived installation can be hidden but never shown again.

## Publication checks

`showToStudents` runs every check on the server, every time. The professor's confirmation dialog shows them but is never the boundary. All checks run, so the professor sees every problem at once. The checks about the version itself are `reviewVersionForStudents`, which a version switch on a visible tool runs too (see [Upgrade, rollback, unpublish](#upgrade-rollback-unpublish)).

### Hard blockers

| Code | Refuses when | Checked by |
|---|---|---|
| (generic refusal) | The caller isn't the section's professor, or the installation isn't in their section | Service, then the database function |
| `kill_switch` | The global Studio kill switch is engaged, or can't be read | Service (`access.ts`) |
| `release_gate` | `STUDIO_STUDENT_ACCESS` isn't `on` | Service, and again in `isPublishedToStudents` |
| `not_entitled` | The institution doesn't have the `studio` entitlement | Service |
| `not_active` | The installation is archived | Service, then the database |
| `section_archived` | The course section is archived | Service |
| `version_missing`, `version_mismatch` | The current version can't be loaded, or belongs to another project or institution | Service; the database's keys make both impossible today |
| `manifest_invalid` | The stored manifest no longer parses | Service |
| `manifest_v1` | The version uses manifest version 1, which Studio's checks can't pass (no purpose, signals or AI fallback). Save a new version from the builder | Service |
| `bridge_unsupported` | The version's bridge version isn't served any more | Service |
| `student_bundle_missing` | The student bundle is empty | Service; the database refuses an empty bundle at publish |
| `validator_unavailable` | The validator hasn't passed this version yet: not checked, still checking, the browser checks haven't run or didn't finish, the verdict predates the minimum ruleset ("being re-checked"), or it can't be read. Every plugin in production until the runner job is deployed | Service (`prepublish.ts`) |
| `validator_failed` | A check failed, a review was rejected, or the stored content no longer matches its hash | Service |
| `validator_review` | A check waits for a Scholera reviewer (a super admin) in the review queue. The professor has nothing to do | Service |
| `skill_binding_missing` | A manifest version 2 skill slot isn't linked to a skill that still exists in the section, or the links can't be read | Service (`skill-bindings.ts`) |
| `over_quota` | The installation's storage is already full | Service |
| `quota_unavailable` | The storage limits can't be read (the database refuses every write without them) | Service |

`prepublish.ts` reads the validator's verdict for the installation's current version ([studio-plugin-validator.md](./studio-plugin-validator.md)). It answers `passed` only when both validator stages passed for the version's exact content. Anything it can't read is `unavailable`, never `passed`.

The write that shows the tool names the version whose verdict was checked. The database refuses it if another version became active in between.

### Warnings

Shown to the professor; the change waits until they acknowledge them (`acknowledgeWarnings`). A warning never bypasses a blocker.

| Code | When |
|---|---|
| `near_quota` | Storage is at 80% or more of either limit |
| `newer_version` | A newer version of the project is published but not active here |
| `duplicate_label` | Students already see another plugin with the same name in this section |
| `unreleased_material` | The course material Athena read while building this version (its stored provenance, read as it is now) includes something students can't see yet. The warning lists each source and when it opens, and says so when the list was cut short or couldn't be read. Also raised on a version switch |

## The professor's flow

On the plugin's runtime page (`/professor/courses/[sectionId]/studio/[installationId]`), section professor only:

- **Status:** "Visible to students", "Hidden from students" or "Removed from course", with an icon and words, never color alone.
- **Show to students…** opens the plugin card (rule 8.2): name and version, what students can do, what staff can do, the data it saves and who sees it, storage use and each student's allowance, and AI, grading and activity tracking (each a plain "This tool doesn't…" line in V1, said explicitly rather than left out). Then the blockers, then the warnings. With any blocker the confirm button is disabled and warnings can't be acknowledged. With only warnings the professor ticks "I've read these" first. The dialog shows the server's checks from page load; confirming runs every check again on the server, and a refusal replaces the list with the server's latest answer. The dialog also lists the validator's findings, with a "Run browser checks" button, and a picker for each skill slot. Both sit right under the blockers, since they're what clears them. A check a Scholera reviewer decided reads "Approved by a Scholera reviewer" or "Rejected by a Scholera reviewer", with their note. While a check runs, the dialog re-reads the page every 5 seconds, and every 30 seconds while one waits for a reviewer. Where no runner is configured, the button is replaced by a note that browser checks aren't available yet.
- **Hide from students** and **Remove from course** each ask for confirmation first. Neither deletes a record.
- **Preview version** lists the plugin's published versions (newest first, at most `STUDIO_PROJECT_VERSIONS_LISTED`) and opens one on sample data. While previewing, "Use vX in the course" (or "Roll back to vX" for an older version) makes it the course's version (see [Upgrade, rollback, unpublish](#upgrade-rollback-unpublish)).
- **After the accepted checks were raised,** the page says "Studio's checks were updated. This tool is being re-checked."

**From the builder.** After "Save as version", the builder's Save card offers the next step in place: "Add to this course" when the course doesn't have the tool (`installPlugin`, which starts hidden), or "Use this version in the course" when it has another version (`approveAndActivateVersion`). It shows the plugin card first, or for a new version what it can do that the course's version can't (rule 8.2), and says when students would get the new version at once. Either way Studio's browser checks then start on their own, within quota; the card says what happened to them, and if they couldn't start the tool page keeps its "Run browser checks" button. `addVersionToCourse` in `lifecycle.ts` and `addSavedVersionToCourse` in the builder service do the work.

The actions (`studio/[installationId]/actions.ts`) are thin: they authenticate, confirm the section's professor, call `showToStudents`, `hideFromStudents` or `archiveInstallation`, refresh the runtime page and both course layouts, and return `{ success }` or `{ error, blockers?, warnings? }`. Every rule and the audit live in the services. The page reads everything it shows from one professor-only call, `getPublicationPanel`.

When the plugin is read-only, the professor's notice says why: removed from the course, course archived, or the institution's plan no longer includes Studio. Students only ever see the generic "You can look through it, but changes won't be saved."

**Hiding** has no checks beyond being the section's professor. It works while the kill switch is engaged, after the entitlement is lost, and on an archived installation, because it only reduces what students can reach.

## Entitlement and kill switch

| | Entitlement | Kill switch |
|---|---|---|
| Question | Has this school got Studio? | Has Scholera stopped plugin execution? |
| Stored in | `institutions.settings.entitlements`, key `studio`, off by default | `platform_settings.settings.studio.disabled`, one global flag |
| Written by | Super admins, through the existing entitlement editor | Super admins, on `/super-admin/ai-controls` ("Studio" card), which calls `set_studio_kill_switch(boolean)` |
| On a read error | Treated as entitled (fails open, like every entitlement) | Treated as engaged (fails closed) |
| Effect | `read_only`: history readable, no new work | `off`: nothing runs |

Both are folded into `studioAccess(institutionId)`: `full`, `read_only` or `off`.

**The kill switch control.** A "Studio" card on the AI Controls page shows the current state and changes it after a confirmation. The action checks `verifySuperAdmin`, then calls the database function through the signed-in user's own client, so Postgres checks `is_super_admin()` too; neither the page nor the action is the boundary. Each change is audited (`studio.kill_switch.engaged` or `.released`). If the switch can't be read, the card says Studio is treated as paused and offers only to pause.

| Where | Kill switch engaged | Entitlement lost |
|---|---|---|
| Studio builder page | Builder actions refused | 404 (the entry page dead-ends, like every unentitled feature) |
| Create, publish, install, upgrade, roll back | Refused ("Studio is paused") | Refused (plan message) |
| Show to students | Blocked | Blocked |
| Hide, archive | Allowed | Allowed |
| Professor runtime page | "Studio is paused" state | Loads read-only |
| Student runtime page | Not found | Loads read-only |
| Frame route | 404, even with a valid ticket | Serves |
| Bridge reads | `unavailable` | Allowed |
| Bridge writes | `unavailable` | Refused (`not_available`) |
| Open frames | Stop at their next call or heartbeat | Become read-only at their next heartbeat |
| Course tabs | Students: none. Professors: unchanged | Unchanged |

So "plugins stop taking new work but historical results remain readable" means: frames load, `records.list`, `records.get`, `context.get` and `course.skills` answer, and `records.create`, `records.update` and `records.delete` are refused for everyone, professors included.

## Who may write

`resolveViewer` (`context.ts`) computes `writable` for every viewer, and the record policy refuses every write when it's false:

```
writable = installation active
       AND section not archived
       AND Studio access is full (entitled, kill switch off)
       AND (viewer is staff OR enrollment is 'enrolled')
```

A student whose enrollment is `completed` can still read their own work but not change it. A dropped student reaches nothing.

## Student route

`/student/courses/[sectionId]/tools/[installationId]`

1. The page checks access itself before reading anything. The section layout's enrollment check isn't enough, because layouts and pages render in parallel.
2. `resolveViewer(installationId)` is the whole decision: session, installation, `isPublishedToStudents` (release gate and visibility), enrollment (`enrolled` or `completed`), kill switch.
3. The viewer must be a student, and the installation must be in the section named in the URL.
4. The view comes from the role, never the URL. The page signs a frame ticket for `student` only, and the frame route serves exactly the view the ticket names, so the professor bundle never reaches a student. A leaked professor ticket would expose code, not data: data still comes through the Bridge under the student's own session.
5. `PluginHost` runs on the real Bridge with the student view's allowed methods and `readOnly = !writable`. No editing or publication controls.

Every refusal is the same `notFound()`: an unknown ID, another section's plugin, a hidden one, a dropped student. The Bridge answers all of them `unavailable`, and the frame route 404s. Installation IDs are random UUIDs and hidden ones never reach a student's browser, so guessing learns nothing.

## Course tabs

| Tab property | Comes from |
|---|---|
| Name | The current version's manifest `name` (rendered as text) |
| Icon | One fixed Studio icon. Manifests have no icon, and a plugin-supplied SVG would be an injection surface |
| Order | `sidebarOrder`, key `studio:<installationId>`. Unordered tabs come last |
| Who sees it | `student_visibility`, read by `navigation.ts` |

- **Students** see active installations that are `visible`, filtered in SQL. None while the release gate is closed or the kill switch is engaged.
- **Professors** see every active installation, with an "eye off" mark and "Hidden from students" text on hidden ones. TAs and graders don't get plugin tabs; the runtime page is professor-only.
- **Archived** installations leave both sidebars.
- **Course assistants** don't get plugin tabs. Their Studio page says how many tools the course has and that only the professor can open or change them.

## Student history

Students find tools that were removed from a course under **Past tools**, below the course's About page, read-only. Only archived installations that were **visible to students when archived** appear, filtered in SQL (`studentPastTools`). One that was hidden never does. The list is empty while the release gate is closed or the kill switch is engaged. Opening one goes through the same student route and checks as any tool, and shows the read-only notice.

Tools in an archived course, or for a student whose enrollment is completed, stay in the course's own sidebar, read-only.
- **Security never reads navigation.** `resolveViewer` never reads `sidebarOrder`, `sidebarHidden` or `enabledFeatures`. Studio is not an `enabledFeatures` key for students: each installation is a row with its own visibility. The reorder action accepts `studio:<uuid>` keys by shape only, because an order key grants nothing.

## Storage quota

The limits are named settings in one database row, `studio_plugin_limits` (server-only), which the trigger and the server both read. Changing one is an update to that row, not a migration, and there is no second copy to drift.

| Setting | V1 value |
|---|---|
| `installation_max_records` | 50,000 records per installation |
| `installation_max_bytes` | 50 MiB per installation |
| `student_max_records` | 1,000 records per student per installation |
| `student_max_bytes` | 1 MiB per student per installation |

**Who counts against what.**

- Every record counts toward its installation.
- A record with an owner, a `perStudent` record (one student's own work), also counts toward that student. Students only ever write their own `perStudent` records, so the owner is the author.
- A record with no owner (`shared` or `staffOnly`, written by staff) counts toward the installation only. Staff content is the course itself.

**Why these values.** At 1 MiB, one student's whole allowance is 2% of the installation's bytes, so filling a class's storage takes 50 students each at their limit instead of one. 1,000 records covers several saves a day for a whole term. A student at the Bridge's write limit reaches their own cap in a couple of minutes and is stopped there, without touching classmates. The cost: a heavy legitimate user can hit their cap. If that happens, raise `student_max_*` in the row.

**How it's enforced.** One counter row per installation (`studio_plugin_usage`) and one per student per installation (`studio_plugin_student_usage`), both server-only. A trigger on `studio_plugin_records` updates them in the same transaction as every insert, update and delete, always the installation's row first and then the student's, so two writers can't deadlock:

- **Insert** takes one record and the new row's bytes; **update** changes bytes by the difference; **delete** gives both back.
- Taking space is one conditional `UPDATE ... WHERE record_count + 1 <= max AND record_bytes + delta <= max`. If no row matches, the trigger raises `program_limit_exceeded` (54000) and the whole write is undone. A multi-row insert that would pass the limit stores none of its rows.
- A write that shrinks or keeps usage always fits, so a lowered limit never traps existing data.
- Bytes are `octet_length(data::text)`, the JSON as Postgres stores it.
- Every record counts, archived or not.
- A student's first record creates their counter row; a concurrent first write by the same student waits on the key and then finds it.
- If the limits row is missing, the trigger refuses every write rather than allowing everything.

**Why counters, not a count query or server memory.** Counting before inserting lets two concurrent requests both see 49,999 and both succeed. Server memory is per Cloud Run instance. The row lock on the counter makes writers to one installation queue for the length of one insert, so exactly one of two racing writers gets the last slot. The cost: writes to the same installation are serialized for the length of a single insert. At the Bridge's own limit (30 writes per user per minute), a 300-student section peaks at 150 writes a second on one row, which Postgres handles. Different installations never contend.

A refused write reaches the plugin as the Bridge error `full`. The message says which allowance: "This tool has run out of storage space, so this wasn't saved" for the installation, "You've used all the storage this tool gives you, so this wasn't saved" for the student's own. It is logged as `studio.record.quota_refused` with identifiers and which limit, never contents.

## Open frames: the heartbeat

A frame learns it has lost access in two ways:

1. **Any Bridge call** answered `unavailable` stops it at once (`stopped`, reason `unavailable`). The plugin's call gets no answer.
2. **The status heartbeat.** A running live frame posts `{ type: 'status', installationId, expectedVersionId }` every `STUDIO_FRAME_STATUS_INTERVAL_MS` (60 seconds), so a plugin that makes no calls is also caught within one interval. The answer is one of four words and nothing else:

| Status | The host |
|---|---|
| `available` | Allows writes |
| `readOnly` | Refuses writes before the network |
| `stale` | Freezes the frame (Step 4 behavior) |
| `unavailable` | Stops and removes the frame |

The heartbeat goes through the same route checks as a call (origin, session, rate limits) and `resolveViewer`. One check runs at a time; a failed check changes nothing; it stops when the frame stops. Preview frames have no heartbeat. An `unavailable` stop isn't reported back as a runtime event, because it was the server's own decision. The limit: a frame keeps running in an open tab for up to one interval after access ends.

## Upgrade, rollback, unpublish

| Event | Open student frames | Records |
|---|---|---|
| Upgrade (approve and activate) | `stale` at the next call or heartbeat; "Reload" | Kept and readable. The publish trigger only accepts versions whose existing collections are identical |
| Rollback | Frames on the newer version go `stale` | Records in collections only the newer version declared stay stored, unreachable until the professor moves forward again |
| Hide | `unavailable` at the next call or heartbeat | Kept. Showing it again restores access |
| Archive | Read-only at the next heartbeat | Kept and readable |

Visibility doesn't change on upgrade. While students can see the tool, an upgrade or rollback runs `reviewVersionForStudents` on the target version: every version blocker refuses it (validator verdict, `manifest_v1`, skill slots and the rest), and warnings such as `unreleased_material` need acknowledging (`acknowledgeWarnings`, the same round trip Show has). The database refuses the switch if the tool was shown or hidden after that check. The tool page's switch approves the version again, which changes nothing for a version this course already approved; the database requires an approval row for whatever version is current.

**Previewing another version.** The professor picks a published version of the same plugin from "Preview version" on the runtime page (`?version=<id>`). The server checks it: section professor only, the same project and institution, a manifest that still parses (`candidateVersion`), otherwise 404. The frame ticket names that version, so the frame route serves its own student or professor bundle. It always runs on the preview bridge with sample data. Nothing changes: not `current_version_id`, not visibility, no approval and no record. Its ticket is useless on the live Bridge, which answers `stale` for any version but the current one. Previewing is UX, not a gate; the validator is.

## Audit

Identifiers only, never record contents or student answers.

| Event | Metadata |
|---|---|
| `studio.installation.shown` | installation, version |
| `studio.installation.hidden` | installation |
| `studio.installation.show_blocked` | installation, version, blocker codes |
| `studio.installation.archived` | installation |
| `studio.validation.runtime_requested` | installation, version, run |
| `studio.skill_slot.bound` | installation, slot, skill |
| `studio.validation.review_approved`, `studio.validation.review_rejected` | run, check |
| `studio.validator.ruleset_raised` | from, to, how many institutions were queued |
| `studio.plugin.installed`, `studio.version.activated`, `studio.version.rolled_back` | installation, version |
| `studio.record.quota_refused` | installation, version, collection, operation, which limit |
| `studio.kill_switch.engaged`, `studio.kill_switch.released` | the super admin who changed it |

Losing or regaining the entitlement is written by the existing entitlement editor.

## Release gate

`STUDIO_STUDENT_ACCESS` is server-only and off unless set to exactly `on`. While it's off, `isPublishedToStudents` refuses every student, the student sidebar shows no plugins, and nothing can be shown. The code exists so it can be tested locally; **production student access is not release-ready** until all of these pass:

1. Real Supabase migration and database-test acceptance ([studio-supabase-acceptance.md](./studio-supabase-acceptance.md)).
2. Real PostgREST query tests for every `db.ts` query, including this slice's.
3. Regenerated Supabase types.
4. Supabase Security and Performance advisors clean or reviewed.
5. The dedicated runtime origin verified on the deployment ([studio-plugin-runtime.md](./studio-plugin-runtime.md), deployment checklist).
6. The validator's runner job deployed and verified on GCP (no credentials, no egress, Chromium's sandbox on, limits enforced). The code, the job's infrastructure script and the app's dispatcher are built ([studio-plugin-validator.md](./studio-plugin-validator.md), "Pending before students can use Studio").
7. The browser isolation probes passing against the deployed origins.
8. The per-student storage cap (built in Step 5C) verified on real Postgres, including the two concurrency tests that PGlite skips.

The review queue (`/super-admin/studio-reviews`) and the revalidation trigger (the AI Controls "Studio validator" card) are built.

## Not built yet

- Deploying the validator's runner job ([studio-plugin-validator.md](./studio-plugin-validator.md)). Until it runs, nothing can be shown to students in production.
- Hide and remove from the plugin's sidebar tab. They're on the runtime page only.
