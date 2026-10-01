# Recent Changes

A running log of what's shipped, updated at the start of each documentation pass. Read top to bottom, newest first. This is a summary of git history, not a replacement for `git log` — dig into a specific commit if you need exact detail.

**Covers:** 2026-08-28 through 2026-09-29 (the last onboarding-guide-current period through today).

## 2026-09-29 — Auth polish

- Show/hide password buttons on login-type forms, plus a fix for a CSS bug that was silently swallowing clicks on nearby elements.

## 2026-09-25 — Live Classroom on mobile

A cluster of fixes making Live Classroom actually usable on a phone, not just a laptop:

- Slide clicks were being swallowed on touch devices; fixed.
- The stage (professor's view) is now properly lit while the projector output stays dark, so the room's screen doesn't wash out with UI chrome.
- The student's "Answer" button now works on a phone.
- The 12-hour auto-end clock for a live session now actually starts when the class starts (it wasn't being armed correctly before).
- A cancelled session's slide deck is now only deleted if the cancel genuinely went through, closing a case where a failed cancel could still delete the deck.

## 2026-09-21 — Athena reads attachments everywhere

Athena's authoring dock can now read files a student or professor has attached, on every Studio surface (not just some), plus a fix so the console's "searching the web" status doesn't say "Done" while the search is still running, and a fix so the "attach your files" hint only appears on builders that actually have that step.

## 2026-09-15 to 2026-09-17 — Demo tenant and QA sweeps

A large effort building out a realistic demo institution ("Northcrest") with seeded courses, materials, extraction data, and skill mastery, followed by multiple rounds of red-team QA passes that found and fixed real data-consistency bugs (null fields, incorrect upsert keys, reviewers being credited as graduates when they'd only enrolled, AI grading citing timing claims not backed by real data, lecture handouts missing real extraction data). This is the seed data other people demo the product from — worth knowing if something in a demo course looks wrong, it may be a seed-data issue, not a product bug.

## 2026-09-15 to 2026-09-16 — Athena gets a Projects authoring surface

Athena can now work inside the **Projects** feature: it can read the state of a team's project board, stage a proposed change, and apply it atomically once the professor confirms — following the same "propose, then a human approves" pattern used everywhere else Athena writes anything. Shipped alongside a system design doc and a cost-tracking entry for this new AI surface.

## 2026-09-15 — About page redesign, ABET on every surface, security hardening

- The course **About page** block editor was redesigned, adding a "Keep / Undo" review flow specifically for changes Athena proposes there.
- Accreditation (ABET) outcome coverage is now readable from every professor-facing Athena surface, not just one.
- Security cleanup: private team columns and the ability to directly write to them were removed from client-facing database roles; authenticated write grants were revoked from tables that had no row-level security policy protecting them (a gap that could have allowed writes nothing was actually checking).

## 2026-09-14 to 2026-09-10 — Entitlements (selling features per school)

A new system for selling specific product capabilities per institution rather than an all-or-nothing plan: a school can lack a feature entirely, and the product now consistently hides that feature everywhere it would otherwise be advertised — including captions, hints, and broken-state messages that previously still named "Athena" even when the school's plan didn't include it. Includes an email to the school when their plan changes, and a fix for the page-level gate on the Athena assistant itself.

## 2026-09-08 — Topic Mastery correctness pass

A multi-slice fix to the skill-mastery system: mastery now bootstraps correctly and scores right on a student's very first attempt, "at-risk" detection works even for a course with no quizzes yet, each question about topic performance now gets exactly one consistent answer instead of conflicting numbers depending on where you looked, and empty states now say specifically what data is missing rather than showing a blank screen.

## 2026-09-07 — AI grading calibration flywheel

Assignment grading with AI got an "evidence-first" review flow: the AI drafts a grade per rubric criterion with a verbatim quote as evidence, high-stakes criteria hide the AI's verdict until the professor decides for themselves (so the professor isn't anchored by the AI's opinion), every time a professor overrides the AI it's recorded, and those corrections feed back into future grading as examples — with a running "AI matched your decisions on X of Y criteria" indicator so the professor can see the AI calibrating to their standards over time.

## 2026-09-02 to 2026-09-07 — Athena gets memory

A significant feature: Athena can now remember things a student or professor has told it across conversations — what a student is working on, an accommodation they've mentioned — without storing the underlying sensitive reason behind it (e.g., it keeps "extended deadline granted," not the medical or personal explanation a student gave for needing one). This shipped with its own red-team pass that found and fixed real leaks (memory quietly destroying what it should have kept, a classifier not recognizing common ways people phrase things, a catch block that was accidentally logging the very preferences it was supposed to protect). See [MEMORY-LAYER.md](./MEMORY-LAYER.md) for how this differs from the course-content memory (extraction/vectors/skills).

A student can also now resume a past Athena conversation from any surface, with a history drawer shared across all of them.

## 2026-08-28 to 2026-08-31 — Round of smaller fixes

A batch of miscellaneous fixes from a broader review pass: a student's weakest topics now surface directly on their dashboard, live classroom attendance can be checked in with a code shown off the projector (for a room without personal devices out), a deleted chat message's attachment file no longer lingers in storage after the message is gone, a guard against a development laptop accidentally writing to or deleting from the production vector index, and a shared motion/animation language applied consistently across loading and transition states.

## What to watch

- The **demo/Northcrest seed data** work (Sep 15-24) is actively maintained — expect continued QA passes as gaps are found.
- **Entitlements** (Sep 9-14) is a new cross-cutting system — any new feature should be checked against whether it needs to respect an institution's entitlement, not just the AI kill switch.
- **Athena memory** (Sep 2-7) is young and was already red-teamed once — treat any change touching it as security-sensitive by default, the same as the AI kill switch or RLS.
