# Assignment Studio v2 — Ungraded · Scheduled Publish · Rubric + PDF — browser walkthrough

**Target:** local dev (`localhost:3000`) + local Supabase (migration `…_assignment_studio_v2` applied), real **Gemini** key (`GOOGLE_GENERATIVE_AI_API_KEY`) in `.env.local` for the AI rubric step.
**Driver:** any MCP browser (this run used Claude Preview; Chrome DevTools MCP works too — see [README.md](./README.md)).
**Date:** 2026-06-19
**Build under test:** branch `feature/assignment-studio-v2` — ungraded assignments, scheduled publish (pg_cron), and rubric + PDF (upload in wizard/detail, AI-suggested rubric, rubric beside grading). *(MCQ — Feature 3 — is not in this branch yet.)*

> Seed: `bash scripts/dev-setup/setup-local.sh` → `professor@scholera.dev`, `student1–6@scholera.dev`, pw `<password in .env.local>`, CS101 (section `bec3377d-1a20-5b5d-8fd0-58095a4438bc`). Have a **text-based** PDF handy for the rubric step (a scanned/image PDF won't yield text).

---

## Setup
1. Sign in as **professor@scholera.dev** / `<password in .env.local>`.
2. Go to a section → **Assignments** (`/professor/courses/<sectionId>/assignments`).

## A. Create wizard — ungraded · scheduled · PDF  *(verified ✅)*
1. Click **New assignment**. On **Details** you now see, below Due/Points:
   - **Ungraded** toggle — *off by default* (graded). Turning it **on** hides the **Points** field. ✅
   - **Assignment PDF (optional)** file picker. ✅
2. Give it a title, pick **PDF** (or any) on the **Submission** step, go to **Review** — the summary shows **Grading: Graded · N points** (or **Ungraded**). ✅
3. The primary button is a **Publish ▾ dropdown**:
   - **Publish now** → publishes immediately. ✅
   - **Schedule for later…** → reveals an inline **datetime picker** + **Schedule** / Cancel. Pick a future time → **Schedule**. ✅
4. **Verify in the list:** a *scheduled* assignment shows a **Scheduled** badge + "Publishes <time>"; an *ungraded* one shows **Ungraded** instead of points.

> To confirm the **pg_cron auto-publish**, set `scheduled_publish_at` a couple of minutes out (or in the past via SQL) and wait for `publish_scheduled_assignments` (runs every 5 min) — status flips `scheduled → published`. Scheduled assignments are **not** visible to students until then (RLS).

## B. Rubric + PDF on the assignment  *(editor verified ✅; live AI gen = manual pass)*
1. Open an assignment → the detail page shows an **Assignment PDF** card (upload / replace / remove) and a **Grading rubric** card. ✅
2. Upload a text PDF in the card (or it's already attached from the wizard).
3. Click **Generate from PDF** → AI (Gemini) drafts a Gradescope-style rubric: questions/subquestions (e.g. `Q1`, `Q2(a)`) each with criteria + points. *(Live Gemini call — exercise this manually with a real PDF.)*
4. **Edit**: change labels/points, add/remove questions + criteria. Click **Save rubric** (persists to `settings.rubric`). The editor **pre-loads** a saved rubric on reload. ✅

## C. Grading against the rubric  *(verified ✅)*
1. On the assignment detail (grader), pick a student in the roster.
2. The detail panel shows their submission **with the rubric on the side** (RUBRIC → Q1 (10 pts): Correct approach 6, Handles edge cases 4 · Q2(a)…). ✅
3. Enter the score + feedback as usual. *(Rubric is a read-only reference for now — interactive tick-to-sum scoring is the next step.)*

## D. Ungraded grading view  *(verified ✅)*
1. Open an **ungraded** assignment's grader → segments collapse to **Submitted / Not submitted** (no "Needs grading/Graded"); the detail panel shows the submission with **no score form** and a "not graded — recorded as complete" note. ✅

## E. Student side
1. Sign in as **student1@scholera.dev** → open the published assignment.
2. The **Assignment PDF** is shown view-only (FilePreviewLink → MaterialViewer). Header shows **Ungraded** (no points) for ungraded assignments. *(manual pass)*

---

## What was verified live (this run)
Ungraded toggle (label/default/points-hide), Publish dropdown (Publish now / Schedule for later) + datetime picker, Review "Grading" row, Assignment PDF card + wizard PDF field, Rubric editor (generate button present, add question/criterion, save, pre-load), and the **rubric rendering on the side** of the grader (seeded rubric → `RubricReference` aside beside the selected student). lint · typecheck · build · unit suite (1795) green.

## Needs a manual pass (not drivable headlessly)
- Real **PDF file upload** round-trip (browser file inputs can't be set by automation).
- **"Generate from PDF"** live Gemini call against a real text PDF (quality + question/subquestion split).
- Student-side PDF view + the cron auto-publish timing.

## Known follow-ups
- Interactive **per-criterion grading** (tick criteria → auto-sum) — currently the rubric is a side reference.
- **MCQ** assignment type (Feature 3) — not in this branch.
- Model is **Gemini** (no Anthropic key configured); CLAUDE.md's Claude default deferred until provisioned.
