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
| `studio/` | Studio plugins. Contract: `manifest.ts`, `capabilities.ts`, `limits.ts`. Trusted server path (the only code that touches `studio_plugin_*`, enforced by `studio-table-access.test.ts`): `context.ts` (session to viewer or professor), `policy.ts` (access table), `record-schema.ts` (manifest to Zod), `db.ts` (queries), `records.ts`, `lifecycle.ts`. Docs: `docs/reference/studio-plugin-{rules,manifest,storage,server}.md` |

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
2026-07-15
