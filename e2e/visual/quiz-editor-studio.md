# Quiz Editor Studio — single-screen create/edit — browser walkthrough

**Target:** local dev (`localhost:3000`) + local Supabase. AI generation needs `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local`.
**Driver:** Chrome DevTools MCP (see [README.md](./README.md)).
**Date:** 2026-07-03
**Build under test:** branch `feature/quiz-editor-studio` — the fork modal + 3-step wizard replaced by a single-screen studio (design: `docs/designs/quizzes/quiz-editor-studio.md`, pain points: #332). Rail · canvas · question-settings sidebar, settings drawer, anchored preview, always-on autosave, publish-dialog naming.

> Seed: `bash scripts/dev-setup/setup-local.sh` → `professor@scholera.dev` pw `<password in .env.local>`. Richest fixture is the hand-seeded CS584 NLP course (section `cccc5840-0000-4000-8000-000000000002`): 20 bank questions, 276 extracted images / 730 formulas for the module-library steps.

---

## Setup
1. Sign in as **professor@scholera.dev** / `<password in .env.local>`.
2. Section → **Quizzes** → **Create quiz**. No fork modal — the button (and the dashboard quick actions) create/reuse an empty draft and land directly on its editor at a clean `/professor/courses/<sectionId>/quizzes/<quizId>` URL (no `/quizzes/new` hop, no `?new=1` flag — the first-time setup spotlight is triggered via a one-shot sessionStorage handoff).

## A. Landing (first visit)  *(verified ✅)*
1. Header shows the ghost **"Untitled quiz"** title (large, with a ✎ edit affordance right after the text — no description here; that lives in Settings → Basic Info) and **Settings / Preview / Publish** buttons; Preview disabled at 0 questions. **Athena is no longer a header button** — it's the floating ask line at the bottom (§ H).
2. Canvas hub: **"Start with your first question"**, a **black split button** (`＋ Multiple Choice │ ▾`, contained — nothing pokes past the rounded clip), an "or bring questions in" divider, and two cards: **Pick from bank** / **Import from JSON**. AI is NOT a card here — it lives in the floating **ask line** (see `athena-quiz-authoring.md` and § H).
3. The split button's **▾ menu** lists the 6 types only — Explanation/Guided Walkthrough stay visible but **disabled** (🔒 + violet "Adaptive only" tag) while Adaptive is off; Adaptive is turned on in Settings. ✅ (Same shared menu in the rail's split button.)

## B. Adding & editing a question  *(verified ✅)*
1. One click on the split button's main side adds a question of the sticky type; **focus lands in the question textarea**; the rail thumb appears and is selected. ✅
2. **Card layout** (borderless in the canvas — no drag handle, no collapse header):
   - Type is a **rounded pill Select** (`Multiple Choice ▾`, info-muted) top-left; AI questions show the **source chip** (`✨ file · p.N`, 👁 peek) beside it. Type locked once persisted (existing behavior). ✅
   - Question text sits in a **GitHub-style frame** with an **attach strip** at its bottom edge: two compact actions — `📎 Add image` (file picker) and a distinct `⛁ Module library` chip. Drag & drop and paste still work (the frame highlights while dragging); no standing copy. No "Add Code Snippet" button — code goes in backtick fences (legacy stored snippets still render an editor with Remove). ✅ The fill-in-the-blank editor lives inside the same frame (frameless), strip included. ✅
   - Quiet "Markdown + LaTeX supported" hint below. No per-card edit/preview tabs and no Insert Formula button — the header **Preview** shows the student view, and formulas come from the **module library** dialog's Formulas tab (inserts at the caret). ✅
   - **MC choices** are bordered rows (correct = green tint), checkbox marks correct, dashed **＋ Add choice** row at the bottom, "Allow multiple correct answers" switch in the section header. ✅
   - **AI-graded types**: Explanation shows an editable **Grading Rubric** panel (numbered concept rows, ✕ remove, dashed **＋ Add concept** — the AI grades free text against these; a new question seeds one empty row); Guided Walkthrough gets the same panel as **Target Insights** (hidden from the student; ＋ Add insight) plus the **Guided Conversation** editor — opening message (tutor opens from the question if left empty) + student turns (2–8). Blank rubric rows are dropped on save; publishing with no rubric is blocked — the message renders **inside the rubric panel** (red border + red text below the rows), as does the AI-generation "needs a rubric" warning (position prefix stripped). ✅ The conversation config round-trips through autosave (regression-tested — it used to be wiped), and so does the rubric (add → edit → remove → reload verified against the local DB; the update payload + autosave dedupe snapshot both used to drop it). ✅
3. **Image attach paths** — all land in the same `attachImage` → `course-materials/<sectionId>/quiz-images/<questionId>`:
   - **Module library** chip → InsertFromLibraryDialog images tab → pick → **Slack-style thumbnail** (name + "click to enlarge" + ✕) appears inside the frame; the strip then **disappears** — the thumbnail is the control, and dropping/pasting a new file swaps the image (the strip returns only while an upload is in flight). ✅
   - **Paste** an image into the textarea → uploads (signed URL) → same thumbnail. ✅ *(verified via synthesized ClipboardEvent; paste isn't advertised in the UI but works)*
   - Thumbnail click → **enlarge dialog** (full-size image). ✅  ✕ removes (deletes the storage file); swapping also deletes the old file. ✅
   - **Add image** (file picker) / OS drag & drop use the same code path — file-picker dialogs aren't drivable headlessly (manual pass).
4. **Question-settings sidebar** (right, `Question settings`, numbered chip + **primary inner-edge accent** binding it to the selected thumb): compact one-row controls — Difficulty (label · ⓘ ranges tooltip · `b` number when adaptive · EASY/MEDIUM/HARD pills in both modes, no number when standard), Discrimination (adaptive; ⓘ tooltip, shows the engine default 1.2 instead of "auto" when unset), Bloom's (label · ⓘ taxonomy tooltip · bold value dropdown), then Points, Tags, Explanation, Bonus/Extra Credit, **Delete question** with Undo toast. ✅

## C. Rail — select, reorder, add  *(verified ✅)*
1. Thumbs show `N · <full type name>` (e.g. `1 · Multiple Choice`, + ✨ for AI, ⚠ when flagged by a failed save) and truncated text; click selects into the canvas (`aria-current` on the selected thumb). ✅
2. **Drag anywhere on the thumb** to reorder (no grip icon; pointer sensor 8px activation keeps clicks working). Keyboard: Tab to the wrapper (`Reorder question N`) → Space picks up, arrows move, Space drops; Enter/Space on the inner button still just selects. ✅
3. Split button (sticky last-used type) + dashed **"Add from AI, bank & JSON"** re-opens the hub mid-quiz. ✅

## D. Autosave, title & publish  *(verified ✅ in the slice-④ run)*
1. Everything autosaves Notion-style — there is **no Save button**. Saves run ~3s after the last edit; the save UI is next to the header actions: a quiet "Saving…" spinner that settles into the mock's green **"✓ Draft saved"** pill ("Saved" on a published quiz). **Empty drafts are never saved** (Gmail-style): a row is created only once a question, title, or description exists — settings-only tinkering stays in memory — and if an empty "Untitled quiz" draft is ever left behind, the next **Create quiz** click **adopts** it (id only, clean defaults) instead of creating another. Published quizzes keep an explicit **Save Changes** (it validates before touching a live quiz). ✅
2. **Publish** opens the dialog: name field (auto-focused when empty, "it's what students will see"), **Publish now / Schedule** pills, confirm disabled until named (and until a future time when scheduling) — the dialog is where naming is enforced; there's no title nag in the header. ✅
3. ⚙ **Settings** opens the right drawer with all quiz-wide sections (description under Basic Info, timing, behavior, adaptive, proctoring…); only the title stays inline in the header. ✅

## E. Ingestion  *(bank verified ✅; AI/JSON manual)*
1. **Pick from bank** (sheet, drawer-matched padding, pinned footer): search + Type/Difficulty filters (adaptive types appear in the filter only when Adaptive is on), checkbox rows with difficulty badges, "Add N questions". Walkthrough/Explanation bank items hidden while Adaptive is off. ✅
2. **Generation is now Athena** — see the walkthrough in `athena-quiz-authoring.md`: ask for questions in the panel, Athena calls `list_modules` (pickable module card with checkboxes), states which modules it is using, then hands off to the SAME streaming run (banner, batch arrival, reattach after reload all unchanged). Cap 50 per call. While a run is live, Athena refuses every edit tool and says so.
3. **Import from JSON**: paste/upload → questions land in the rail for review (manual pass this run).

## F. Adaptive gating  *(verified ✅)*
1. In the split-button menus the adaptive-only types are informational-disabled — 🔒 + violet "Adaptive only" tag, never clickable. Turning Adaptive on happens in **Settings**, after which they become selectable and the header shows the **Adaptive** badge (click → Settings). ✅ Athena mirrors the same rule: asked for an explanation/walkthrough item while Adaptive is off, she says Adaptive must be on and offers to turn it on.

## G. Preview  *(verified ✅ in the slice-④ run)*
1. 👁 **Preview** dissolves the side panels into the student view, **anchored to the selected question** (highlight ring + scroll); banner button returns to editing. ✅

---

## What was verified live (this run, 2026-07-03)
Black contained split button (hub + rail) with the unified menu incl. ingestion items; one-click add + textarea focus; pill type select; attach strip end-to-end (library pick, paste-upload with signed URL, enlarge dialog, remove/replace incl. storage delete); restyled choice rows; drag-anywhere rail reorder (activation from thumb body + full reorder + click-select unaffected); sidebar inner-edge accent; bank sheet layout. Earlier same-branch runs verified: landing hub, untitled autosave + quiet hint, settings drawer, adaptive enable-in-place + IRT sidebar controls, anchored preview, publish dialog gating. lint · typecheck · unit suite (2080) green.

## Needs a manual pass (not drivable headlessly)
- **browse files** picker and OS-level drag & drop onto the frame (same `attachImage` path as paste, which is verified).
- **Athena generation** live Gemini call (quality, citations, auto-attached source crops) — plus the module card pick flow, an edit attempt DURING a run, and a PDF dropped into the panel.
- **Import from JSON** round-trip; student-side taking of a published quiz.

## Known follow-ups
- Staged AI results panel (review before questions join the rail) — explicitly out of this PR.
- Difficulty↔IRT-b mapping extraction to `src/lib/quiz/` with boundary tests.
- Unsized-image CLS in the student preview.
