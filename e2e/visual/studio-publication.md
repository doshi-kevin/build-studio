# Studio publication: plugin card, validator checks, skill slots, hide, remove, version preview, past tools

**Target:** local dev (`localhost:3000`) with local Supabase. Mechanics: [README.md](./README.md).
**Build under test:** Studio Steps 5C and 6.
**Last run:** never. The machine this was built on can't run local Supabase. The pieces each step relies on have unit, database and runtime-harness tests (see `docs/reference/studio-plugin-publication.md`); this file covers what only a real browser on the real app shows.

## Setup

1. Grant the dev institution the `studio` entitlement: super admin, Institutions, the institution's Plan card. Without it the Studio tab is gone and plugins are read-only.
2. Set `STUDIO_STUDENT_ACCESS=on` in `.env.local` and restart the dev server. Production keeps it off.
3. Install a plugin with at least two published versions into CS101 (through `lifecycle.ts`; there is no builder UI yet). Note its installation ID.
4. Have a student account enrolled in CS101 (`student1@scholera.dev`).

## A. The plugin card can be read but not confirmed

1. As the professor, open `/professor/courses/<CS101>/studio/<installation>`. Expect "Hidden from students" with an eye-off icon.
2. Press **Show to students…**. Expect the card: name and version, what students can do, what staff can do, the data it saves, storage, and lines saying the tool doesn't use AI, grade, or record activity.
3. Expect a calm "Not ready for students yet" box with the automatic-checks message, and **Show to students** absent. Directly under it, expect "Studio's automatic checks": a failing test plugin lists what didn't pass, each labelled "Didn't pass".
4. Close it. Expect nothing changed: still "Hidden from students", no new student tab.

## B. Hide removes a student's access

If the plugin doesn't pass the validator, make it visible directly for this check: `select public.studio_set_student_visibility('<installation>', '<CS101>', 'visible', '<professor id>', (select current_version_id from public.studio_plugin_installations where id = '<installation>'))` in the local database.

1. As the student, open CS101. Expect the plugin's tab (puzzle icon) and that it loads.
2. As the professor, reload the runtime page (expect "Visible to students"), press **Hide from students**, and confirm.
3. In the student's open tab, expect the tool to close within a minute with "This tool isn't available right now". After a reload the tab is gone and the URL is not found.

## C. Remove from course

1. Make it visible again (as in B), and save something as the student.
2. As the professor, press **Remove from course**. Expect a confirmation that says saved work is kept and the tool can't be shown again. Cancel once, then confirm.
3. Expect "Removed from course" and no other controls; the professor's sidebar tab is gone.
4. As the student: the tab is gone, and the course's About page shows **Past tools** with the plugin marked "Read-only". Opening it shows their saved work and the read-only notice; saving is refused.

## D. Preview another version

1. On the runtime page, choose another version in **Preview version**. Expect the URL to gain `?version=`, a "Preview · v…" badge and "Sample data. This version isn't active in this course yet."
2. Switch to the student view and back. Expect the version to stay selected.
3. Expect nothing about the course to change: the active version in the picker, the visibility badge, and the student's own view are unchanged. In the network panel, expect no request to `/api/studio/bridge` while previewing.
4. Change `?version=` to a random UUID. Expect not found.

## E. Studio kill switch

1. As a super admin, open `/super-admin/ai-controls`. Expect a "Studio" card saying Studio is running.
2. Press **Pause Studio everywhere** and confirm. As the student, an open tool closes within a minute; as the professor, the runtime page says Studio is paused, and **Hide from students** still works.
3. Turn it back on.

## F. Copy

1. As a TA in CS101, open the Studio tab. Expect "This course has N tools" when tools exist, not "Nothing built".
2. As the professor, revoke the `studio` entitlement and open the plugin. Expect the read-only notice to say the institution's plan no longer includes Studio. As a student, expect the generic read-only notice.

## E. The validator's checks and skill slots

Set `STUDIO_VALIDATOR_RUNNER=local` in `.env.local` and restart. Install the known-good fixture (`GOOD` in `src/lib/studio/validator/fixtures.ts`, manifest version 2) into CS101, and give CS101 at least one confirmed skill on the Roadmap.

1. Open **Show to students…**. Expect "Code checks: Passed", "Browser checks: Not run yet", a **Run browser checks** button, and a "Skills it counts toward" picker for "The topic this ticket is about", all above "Students can".
2. Press **Run browser checks**. Expect "Running" and "This can take a few minutes. You can close this and come back." Without touching anything, expect it to change to "Passed" within a few minutes.
3. Pick a skill in the picker. Expect the choice to show at once, and the skill-slot blocker to leave the box without closing the dialog. With no other blocker, **Show to students** appears.
4. Remove `STUDIO_VALIDATOR_RUNNER` and restart. Publish a new version. Expect "Browser checks aren't available yet. Until they are, students can't see this tool." and no button.
5. With no confirmed skills in the course, expect "Add skills on the Roadmap" to link to the Roadmap page.
