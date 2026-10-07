# Studio release: from Save to students, review, revalidation, switch, roll back

**Target:** a guarded production build (`node e2e/serve-guarded.mjs`) against a local database. Mechanics: [README.md](./README.md).
**Build under test:** Studio Steps 9 and 10 ([studio-plugin-validator.md](../../docs/reference/studio-plugin-validator.md), [studio-plugin-publication.md](../../docs/reference/studio-plugin-publication.md), the course material section of [studio-agent-harness.md](../../docs/reference/studio-agent-harness.md)).
**Last run:** 2026-10-02, scripted with Playwright: 40 of 41 checks passed. It ran on the guarded production build under Node 22 against a local PostgreSQL 17 with real PostgREST (not local Supabase), with the runtime origin behind a local https proxy. No model was called and no `.env` file was read. The one failure is outside Studio: the course header's institution label (`DashboardHeader.tsx`, `text-muted-foreground/60`) fails axe's color-contrast rule on the student page.

## How this run is set up

Nothing in this walkthrough may reach production. `serve-guarded.mjs` copies the working tree without any `.env*` file, builds with only loopback `NEXT_PUBLIC_*` values, searches the build for the production project ref and any hosted Supabase host, and serves it with an environment built from `E2E_<NAME>` variables only. Every browser context also blocks requests to `*.supabase.co`.

What is real and what is seeded:

| Step | How |
|---|---|
| Builds | The real harness, check worker and database, with a scripted model (two builds, one searching the course). No model call |
| Save, Add to this course, Use this version, Roll back, Show, Hide, Remove | Real, in the browser |
| Stage 1 | Real, at Save. With no classifier key the purpose check goes to review |
| The review | Real, in the super admin's queue (for 1.0.0). For 1.1.0 the approval row is written in SQL, as the queue writes it |
| Stage 2 | **Seeded** in the 2026-10-02 run. A production build refused the local runner then, and the cloud runner needs GCP, so a passed runtime result for the exact artifact was inserted in SQL. Since 2026-10-03 the guarded build runs the local runner when it is given `E2E_STUDIO_VALIDATOR_RUNNER=local` and `E2E_STUDIO_VALIDATOR_RUNNER_ROOT`, so the next run can use real Stage 2 instead of the seed |

## Setup

1. A section for the fixture professor with two enrolled students, Studio granted, and two weeks of course material: week 5 open, week 6 opening in 7 days.
2. One build through the harness that searches "respiration glycolysis", so its provenance includes week 6.
3. The guarded server on `:8080` with `STUDIO_STUDENT_ACCESS=on`, `STUDIO_RUNTIME_ORIGIN=https://127.0.0.1:8443` and local-only secrets, and an https proxy on `:8443`. The proxy is no longer needed: since 2026-10-03 a production build accepts a plain-http runtime origin when the app and runtime origins are both on loopback.

## A. Save and Add to this course

1. Open the build. Expect "Athena read these from your course:" on the ending card.
2. Save as version. Expect "Saved as version 1.0.0." and the version to carry the build's material provenance.
3. Expect the Save card "Add Term flashcards to this course?", saying it starts hidden, with what students and the professor can do and what it saves. axe finds nothing in the builder.
4. Add to this course. Expect "Added to this course. Students can't see it until you show it.", the installation hidden on 1.0.0, Stage 1 `needs_review` (no classifier key), and the card saying why the browser checks didn't start.

## B. The review queue

1. As the super admin, expect the landing page's "Studio check is waiting for a reviewer" link.
2. In the queue, expect the check with the school, course and the tool's stated purpose. axe finds nothing; nothing scrolls sideways at 375 px.
3. Approve with a reason. Expect the review stored with the reviewer and reason.

## C. Show to students

1. As the professor, open Show to students. Expect "Approved by a Scholera reviewer" with the note, and "Browser checks aren't available yet" instead of a button that can't work.
2. Seed the Stage 2 pass. Reopen: expect the warning naming week 6's material with "students can't see this until" its date, and Show disabled until it is acknowledged. axe finds nothing in the dialog.
3. Acknowledge and show. Expect the tool visible. In the professor's own view, add a card.

## D. Students

1. The first student opens the tool, sees the card and marks it known.
2. A second student sees the same card. Expect exactly one progress record, owned by the first student.

## E. A second version

1. A second build (renamed student screen). Save: expect "Saved as version 1.1.0." and "Use version 1.1.0 in this course?", warning that students get it at once.
2. Use it: expect a refusal listing why (1.1.0 hasn't passed), with no button to push past it.
3. Approve 1.1.0's review and seed its Stage 2 pass. On the tool page, preview 1.1.0: expect "Use v1.1.0 in the course" held by the material warning until acknowledged, then the course on 1.1.0.
4. The student's tab, opened on 1.0.0: a write is refused with "A newer version of this tool is in use. This copy has stopped saving." After reload they get 1.1.0.

## F. Roll back, remove, kill switch

1. Preview 1.0.0: "Roll back to v1.0.0", held by the warning, then the course on 1.0.0.
2. Remove from course: the installation archived, and the student sees it under Past tools.
3. With the Studio kill switch engaged, the tool page says Studio is paused.

## Not covered here

Real Stage 2 (the cloud runner needs the job on GCP, and the local runner the guarded build now accepts hasn't been used in this walkthrough yet), a live model build (needs a Google key passed explicitly), revalidation after raising the accepted checks (covered by unit and database tests), keyboard order and focus return (not scripted), and a real screen reader.
