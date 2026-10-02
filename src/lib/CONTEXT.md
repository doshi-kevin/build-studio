# Library Utilities Context

## What This Does
Shared utilities, clients, and infrastructure used across the entire application. This is the "don't duplicate, import from here" layer.

## Files

| File / Directory | Purpose |
|------------------|---------|
| `logger.ts` | Centralized logging with `[SCHOLERA ERROR/WARN/INFO/DEBUG]` prefixes |
| `utils.ts` | Tailwind `cn()` helper (from shadcn/ui) |
| `email.ts` | Email utilities |
| `course-features.ts` | Feature registry (9 toggleable course features, rendered in course sidebars) |
| `supabase/` | Supabase clients, types, queries, event logger, storage, realtime |
| `validations/` | 21 Zod schema files (quiz.ts has discriminated unions for question types) |
| `quiz/` | Quiz scoring (server-side grading), storage interfaces, utils, concept-plan (pure planning for concept-first AI generation) |
| `ai/` | Gemini clients + prompts. Quiz generation is CONCEPT-FIRST (`docs/designs/quizzes/quiz-generation-v2.md`): concepts are extracted ONCE at upload by the extraction worker (stored at `module_items.content.concepts`, page-number markers; `content.topics` is the derived flat view) and merged per-run by `concept-plan.mergeStoredConcepts` — the runtime planning pass survives only as fallback (legacy items, ad-hoc uploads). Ramped batches (3, 5, 10…) generate per-concept from narrowed passages, gated by `quiz-quality.ts` (embedding dedup at cosine 0.85 + answerability audit on `QUIZ_ANALYSIS_MODEL`, both fail open) with jsonrepair salvage; whole-content chunking is the last-resort fallback. Prompts are split static-system + per-call assignment tail for Gemini implicit caching (design §11b) — never put per-call values in the system prompt |
| `calendar/` | Office hours + calendar utilities (storage, feed-builder, ical, events, availability) |
| `classroom/` | Attendance scoring + realtime hooks |
| `roadmap/` | Roadmap assembly, coverage derivation, triage/signal engine, node checks |
| `warehouse/` | Material library storage/utils |
| `studio/` | Studio plugins. Contract: `manifest.ts`, `capabilities.ts`, `limits.ts`. Trusted server path (the only code that touches `studio_plugin_*`, enforced by `studio-table-access.test.ts`): `context.ts` (session to viewer or professor), `policy.ts` (access table), `record-schema.ts` (manifest to Zod), `db.ts` (queries), `records.ts`, `lifecycle.ts`. Plugin runtime in `runtime/`: two origins (`origin.ts`), frame document and its security policy (`frame-document.ts`), signed frame tickets, bridge envelope (`protocol.ts`), host controller (`host.ts`), the host's bridge client and the preview bridge. The Scholera Bridge in `bridge/`: `catalog.ts` (every method, host or server, shared by both), server handlers (`registry.ts`), `dispatch()`, envelope, streaming body cap, rate limits, `context.get`, the status heartbeat answer (`status.ts`); the route is `src/app/api/studio/bridge/route.ts`. Student access: `access.ts` (kill switch, `studio` entitlement, `STUDIO_STUDENT_ACCESS` release gate), `publication.ts` (may students reach this installation), `student-visibility.ts` (show and hide, with the publication checks, and the professor's panel), `plugin-card.ts` (the plugin card the professor reads before showing a tool; pure, client-safe), `prepublish.ts` (the validator's verdict, as the publication gate reads it), `skill-bindings.ts` (manifest v2 skill slots, bound per installation), `edtech.ts` (signal, purpose and AI-fallback lists), `navigation.ts` (plugin course tabs). Pre-publish validator in `validator/`: `ruleset.ts` (every check), `scan.ts` (reads plugin code with the TypeScript parser, never runs it), `static-checks.ts`, `purpose.ts` and `purpose-ai.ts` (rule 9.6, behind the `studio-validator` AI kill switch), `verdict.ts`, `runtime-report.ts` and `runtime-runner.ts` (Stage 2 contract and the local runner in `validator-runtime/`), `service.ts` (runs, verdict, reviews). The plugin kit (React plus kit components, served as `public/studio-runtime/v1/vendor.js`) is in `kit/`. The AI builder is in `builder/` (docs/reference/studio-agent-harness.md): `harness.ts` (the `studio_builder_slice` job: claim, gates, turns, completion, and the upkeep every jobs kick runs to recover or release stalled builds), `tools.ts` (the ten tools, `propose_memory` among them), `model.ts` (the `AgentModel` interface and its Gemini adapter), `context-builder.ts` and `instructions.ts` (the prompt), `manifest-delta.ts` (stamp, validate and classify manifest changes), `checks.ts` (the draft gate), `compile.ts` and `typecheck.ts` (run in the check worker, `check-worker.ts`), `snapshot.ts`, `paths.ts`, `memory.ts` (project memory, pure: what a saved decision may say, the rule that evidence is the professor's own words from the current run, and the deterministic choice of which decisions reach a prompt; rows live in `studio_plugin_memories` and are written only by the `studio_memory_*` functions), and `service.ts` (the professor's entry points, including saving, removing and approving saved decisions). `kit/plugin-kit-types.ts` is the hand-written type environment generated plugin code compiles against. Docs: `docs/reference/studio-plugin-{rules,manifest,storage,server,runtime,publication,validator}.md` and `docs/reference/studio-agent-harness.md` |

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
2026-10-02
