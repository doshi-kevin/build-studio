# Library Utilities Context

## What This Does
Shared utilities, clients, and infrastructure used across the entire application. This is the "don't duplicate, import from here" layer.

## Files

| File / Directory | Purpose |
|------------------|---------|
| `logger.ts` | Centralized logging with `[SCHOLERA ERROR/WARN/INFO/DEBUG]` prefixes |
| `utils.ts` | Tailwind `cn()` helper (from shadcn/ui) |
| `email.ts` | Transactional email through Resend, including the Studio review-queue notice to super admins |
| `course-features.ts` | Feature registry (9 toggleable course features, rendered in course sidebars) |
| `supabase/` | Supabase clients, types, queries, event logger, storage, realtime |
| `validations/` | 21 Zod schema files (quiz.ts has discriminated unions for question types) |
| `quiz/` | Quiz scoring (server-side grading), storage interfaces, utils, concept-plan (pure planning for concept-first AI generation) |
| `ai/` | Gemini clients + prompts. Quiz generation is CONCEPT-FIRST (`docs/designs/quizzes/quiz-generation-v2.md`): concepts are extracted ONCE at upload by the extraction worker (stored at `module_items.content.concepts`, page-number markers; `content.topics` is the derived flat view) and merged per-run by `concept-plan.mergeStoredConcepts` — the runtime planning pass survives only as fallback (legacy items, ad-hoc uploads). Ramped batches (3, 5, 10…) generate per-concept from narrowed passages, gated by `quiz-quality.ts` (embedding dedup at cosine 0.85 + answerability audit on `QUIZ_ANALYSIS_MODEL`, both fail open) with jsonrepair salvage; whole-content chunking is the last-resort fallback. Prompts are split static-system + per-call assignment tail for Gemini implicit caching (design §11b) — never put per-call values in the system prompt |
| `calendar/` | Office hours + calendar utilities (storage, feed-builder, ical, events, availability) |
| `classroom/` | Attendance scoring + realtime hooks |
| `roadmap/` | Roadmap assembly, coverage derivation, triage/signal engine, node checks |
| `warehouse/` | Material library storage/utils |
| `studio/` | Studio plugins. Contract: `manifest.ts`, `capabilities.ts`, `limits.ts`. Trusted server path (the only code that touches `studio_plugin_*`, enforced by `studio-table-access.test.ts`): `context.ts` (session to viewer or professor), `policy.ts` (access table), `record-schema.ts` (manifest to Zod), `db.ts` (queries), `records.ts`, `lifecycle.ts`. Plugin runtime in `runtime/`: two origins (`origin.ts`), frame document and its security policy (`frame-document.ts`), signed frame tickets, bridge envelope (`protocol.ts`), host controller (`host.ts`), the host's bridge client and the preview bridge. The Scholera Bridge in `bridge/`: `catalog.ts` (every method, host or server, shared by both), server handlers (`registry.ts`), `dispatch()`, envelope, streaming body cap, rate limits, `context.get`, the status heartbeat answer (`status.ts`); the route is `src/app/api/studio/bridge/route.ts`. Student access: `access.ts` (kill switch, `studio` entitlement, `STUDIO_STUDENT_ACCESS` release gate), `publication.ts` (may students reach this installation), `student-visibility.ts` (show and hide, with the publication checks, and the professor's panel), `plugin-card.ts` (the plugin card the professor reads before showing a tool; pure, client-safe), `prepublish.ts` (the validator's verdict, as the publication gate reads it), `skill-bindings.ts` (manifest v2 skill slots, bound per installation), `edtech.ts` (signal, purpose and AI-fallback lists), `navigation.ts` (plugin course tabs). Pre-publish validator in `validator/`: `ruleset.ts` (every check), `scan.ts` (reads plugin code with the TypeScript parser, never runs it), `static-checks.ts`, `purpose.ts` and `purpose-ai.ts` (rule 9.6, behind the `studio-validator` AI kill switch), `verdict.ts`, `runtime-report.ts` (the Stage 2 envelope: report plus its binding to run, nonce and payload), `runtime-runner.ts` (runner modes, the payload and the local runner in `validator-runtime/`), `cloud-runner.ts` (the production runner: one Cloud Run job execution per run, signed URLs, the write-once report, collect), `pipelines.ts` (the `studio_validator_runtime` dispatch job whose upkeep collects, and the per-institution `studio_validator_revalidate` job), `service.ts` (runs, Stage 2 quotas and lanes, verdict, the review queue, revalidation). `student-visibility.ts` also holds `reviewVersionForStudents`, the one review of a version for every path to students (Show, Use this version, Roll back). The plugin kit (React plus kit components) is in `kit/`: v1 (`public/studio-runtime/v1/`, frozen and hash-pinned) and v2 (`kit/v2/`, `public/studio-runtime/v2/`, what new drafts build on). The AI builder is in `builder/` (docs/reference/studio-agent-harness.md): `harness.ts` (the `studio_builder_slice` job: claim, gates, turns, completion, and the upkeep every jobs kick runs to recover or release stalled builds), `tools.ts` (the twelve tools, `propose_memory` and `write_sample_data` among them), `model.ts` (the `AgentModel` interface and its Gemini adapter), `context-builder.ts` and `instructions.ts` (the prompt), `manifest-delta.ts` (stamp, validate and classify manifest changes), `checks.ts` (the draft gate), `compile.ts` and `typecheck.ts` (run in the check worker, `check-worker.ts`), `snapshot.ts`, `paths.ts`, `memory.ts` (project memory, pure: the closed topic and slot lists (`MEMORY_SLOTS`, kept in step with the table's check constraint), what a saved decision may say, the rule that evidence is the professor's own words from the current run, and the deterministic choice of which decisions reach a prompt; rows live in `studio_plugin_memories` and are written only by the `studio_memory_*` functions), `course-material.ts` and `course-retriever.ts` (Step 9 course context: the `search_course_material` tool's query, focus, labels and provenance, over the `studio_course_*` SQL functions), `disclosure.ts` (the copy guard for material students can't see yet), and `service.ts` (the professor's entry points, including saving, removing and approving saved decisions, and the Save card's Add to this course / Use this version step). `kit/plugin-kit-types.ts` is the hand-written type environment generated plugin code compiles against. Docs: `docs/reference/studio-plugin-{rules,manifest,storage,server,runtime,publication,validator}.md` and `docs/reference/studio-agent-harness.md` |

## Studio status (Step 11 locally accepted, 2026-10-06)

**STEP 11 — LOCALLY ACCEPTED.** Steps 1 to 11 are built and pass every test that can run without Docker, a GCP project or a production key. The results, the four bugs this closure fixed, and how to run what's still needed are in the "Step 11 closure" section of `docs/reference/studio-supabase-acceptance.md`. **Step 12, Generation Intelligence, may begin.** Production release and student access stay behind a separate gate: real Supabase, the Stage 2 runner on GCP, staging, the deployed Gemini key and a screen-reader pass, plus the [release gate](../../docs/reference/studio-plugin-publication.md#release-gate). Design notes: `docs/designs/studio/studio-builder-quality.md` (gitignored, local only).

What Step 11 added:
- **Roster without names in the frame (rule 2.5 unchanged).** `course.roster` gives professor views opaque per-installation handles (`handles.ts`, HMAC with a per-installation salt). Names are drawn by the host page over a placeholder the plugin reserves (`runtime/roster-overlay.ts`, `rosterNamesAction`); the plugin only sees handles and the actions a professor clicks. Drafts use the synthetic class in `runtime/preview-roster.ts`.
- **`staffPerStudent` records.** Staff write a record about one student; that student reads only their own. Also `records.batch` and `course.assignments`.
- **Kit and runtime v2.** About 30 components with design tokens, auto height, and the roster protocol. v1 is untouched.
- **The builder iterates.** Plan v2 with checkable requirements, `write_sample_data`, then after checks pass a design review (`builder/review.ts`): the views are rendered (`builder/renderer.ts`, local Chromium only) and reviewed against a fixed rubric, at most 2 rounds.
- **Convergence.** A review's improvements get 4 model turns. When they or any run budget run out, the harness keeps the latest draft that still passes every check and renders, or the reviewed one (`polish_stopped`). A crashed view is never kept. A build that never passed its checks still fails. The gate (all but the daily spend limit) runs again right before any commit, so nothing lands after Studio is paused or the professor loses access.
- **Course retrieval is still Postgres full-text search** (Step 9). Pinecone is not used by Studio.
- **Local mode.** The design-review renderer and the Stage 2 validator run locally only on a dev server or a production build whose database is on loopback (`validator/runtime-runner.ts`, `onThisMachine`). A deployed server can't turn them on.

Local testing uses the guarded server (`e2e/serve-guarded.mjs`): values only from `E2E_<NAME>`, loopback Supabase stand-in, locally generated secrets, `STUDIO_RUNTIME_ORIGIN=http://127.0.0.1:3000`, never the root `.env`. Live model runs need a dedicated non-production Gemini key.

## Logger (`logger.ts`)

**Always use this instead of `console.log/error/warn`.**

Methods:
- `logger.error(source, error, context?)` — logs with stack trace if available, parses Supabase error objects
- `logger.warn(source, context?)` — warnings (unexpected but recoverable)
- `logger.info(source, context?)` — significant events worth tracking
- `logger.debug(source, context?)` — development only (skipped in production)

Pattern:
```ts
import { logger } from '@/lib/logger'
logger.error('ComponentName.functionName', error, { userId, extraData })
```

The `source` string follows `ComponentOrModule.functionName` format for easy grep-ability.

## Utils (`utils.ts`)

Contains only `cn()` — the Tailwind class merge utility from shadcn/ui. Do not add unrelated utilities here; create purpose-specific files instead.

## Supabase Directory

See `supabase/CONTEXT.md` for detailed documentation.

## Edge Cases
- Logger debug messages are silently suppressed in production (no performance cost beyond the function call)
- Supabase errors have a unique shape `{ message, code, details, hint }` — `logger.error` handles this automatically

## Testing Considerations
- Logger output goes to console only (no remote logging yet)
- In tests, consider mocking logger to verify error paths are reached
- `cn()` is a pure function, trivially testable

## Last Updated
2026-10-06
