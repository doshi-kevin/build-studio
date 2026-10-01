# CCAT Adaptive Quiz (ENG-38) — end-to-end browser walkthrough

**Target:** local dev (`localhost:3000`) + local Supabase (migration `…69_quizzes_v2_irt` applied), real **Gemini** key in `.env.local`.
**Driver:** Playwright (MCP browser automation). *(This was a 2026-06-07 run log. Future runs use **Chrome DevTools MCP** — driver mechanics in [README.md](./README.md) — and drop a `.webm` here instead of screenshots.)*
**Date:** 2026-06-07
**Build under test:** the CCAT/IRT integration on branch `feature/eng-38-quizzes-v2` — IRT engine ported from the CCAT demo, AI generation emitting `a`/`b`/rubrics, the adaptive step server actions, the dedicated student player, and the results analytics.

> Seed: `scripts/dev-setup/setup-local.sh` (professor@scholera.dev, student1@scholera.dev … pw `<password in .env.local>`, CS101 section). Source material: `CS584_Midterm_Practice.pdf` uploaded to a module and AI-parsed (8 pages).

---

## What was exercised (and verified working)

### Professor — build (3-step wizard, no new page)
1. **Adaptive config in the wizard settings** — `professor/01-adaptive-config.png`: the "Adaptive Quiz" toggle reveals stopping rule (fixed/precision), question count, difficulty-matching `λ`, and "show ability to students". Persists to the quiz row.
2. **AI generation with the new types** — `professor/02-ai-generate-dialog-6-types.png`: the Generate-with-AI dialog now offers all 6 item types incl. **Explanation** and **Guided Walkthrough** (a bug fixed mid-run — they were missing).
3. **Generated questions** — `professor/03-generated-questions.png`, `04-questions-step.png`: a 10-question bank mixing MCQ + Explanation + Walkthrough, generated from the PDF.
4. **Editable IRT params** — `professor/05-editor-irt-ab-fields.png`: each question exposes the AI-seeded **IRT difficulty (b)** and **discrimination (a)** for the professor to tune (added on request). Verified persisted to `quiz_questions` with `irt_a/b/c` + `rubric` (3 nodes on explanation/walkthrough, derived `c`: 0.25 MCQ / 0 free-text).

### Student — adaptive attempt (`student-run/`)
1. `q1-explanation.png` — first item is an **Explanation**, served with the AI-graded textarea; live `θ̂ ± SE` shown.
2. `q1-graded-feedback.png` — *(captured before a later change)* the Gemini rubric grader scored the answer **100% (3/3 nodes)** with a rationale; `θ̂` moved −0.00±1.00 → +0.47±0.88.
3. `q3-walkthrough.png`, `q3-walkthrough-chat.png` — the **Guided Walkthrough** multi-turn interview: the tutor opens, the student reasons across turns, then "End & score" grades the transcript (**67%, 2/3 insights**).
4. `q4-socratic-trigger.png`, `q4-socratic-chat.png` — *(historical)* a hard-item miss originally branched to a Socratic coaching chat. **This coaching tutor was subsequently removed** per product decision; the player now auto-advances on submit like a standard quiz, and a hard miss is only flagged as a misconception for analytics.
5. `results.png` — the results page: **Grade (weighted % correct, deterministic)** shown distinctly from the **IRT ability θ̂ ± SE** diagnostic, plus per-topic mastery and misconceptions.

### Bugs found & fixed during the walkthrough
- **Generation repetition-loop / truncation** — Gemini looped on the unbounded rubric `match` keyword array (45k–238k chars → unparseable JSON, ~4.5 min retries). Fixed by dropping `match` from AI generation (offline grader now derives keywords from the concept) + a `maxOutputTokens` ceiling. 3/3 mixed generations then succeeded in 9–21s.
- **IRT params + rubric dropped on save** — the wizard's `handleAIGenerated` didn't carry `irtA/irtB/irtC/rubric` into `WizardQuestion`. Fixed; verified in the DB.
- **Adaptive routing bypass** — the quiz-list "Start" routed adaptive quizzes to the linear player. Fixed (route to `/adaptive`); plus a server guard so the linear `startAttempt` refuses adaptive quizzes.
- **Mid-quiz answer reveal** — the player showed correctness/rationale after each submit. Changed to auto-advance with no per-item reveal (matches the standard quiz; reveal belongs on results, gated by Show Explanations).

### Engine signals observed (sanity)
θ̂ trajectory across the run: 0.00 → +0.47 → +0.71 → +0.88 → +0.57 (hard miss) → … → −0.53, with SE shrinking 1.00 → ~0.57 as evidence accumulated — i.e. correct answers raise ability and shrink the error band; a wrong hard item pulls it down. Stopped at the fixed length (10 items).
