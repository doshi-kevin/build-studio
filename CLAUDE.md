# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Scholera is an AI-native LMS (learning management system). Next.js 16 App Router frontend with Supabase (Postgres + Auth + Storage + Realtime) backend, deployed to Google Cloud Run via Docker. Multi-tenant: institutions contain professors, students, staff, and admins.

## Who We Build For

From user interviews, corroborated by public research (`docs/reference/user-signals.md`). Use this to break design ties — not to add scope, and not as a lens every feature has to pass through:

- **Professors pay to save time.** Workload is their binding constraint. Prefer removing a step, batching a repeated action, or pre-filling from data we already have — over adding a configuration surface. The inverse matters too: more notifications and dashboards is not the same as less work.
- **Assume professors won't go looking.** Only ~15% of instructors regularly explore new features in their LMS. A feature behind a new nav destination effectively doesn't exist — put it in the flow they're already in.
- **Students are managing logistics across several courses.** They want less course-management overhead, not another system to learn. Prefer surfacing what's due and where to go next over teaching them our navigation.

Much of the work is neutral to this — migrations, infra, bug fixes, and features with a real pedagogical or technical requirement of their own. When a task has no design latitude, ignore this section. And when this framing and what the task actually needs pull in different directions, **say so and ask** — don't silently optimize for the principle.

## Engineering Philosophy

Do not over-engineer. Do not under-engineer. Ask "what is the simplest thing that solves this correctly?" — build that, then stop. If a task says "add a button," add a button; don't also build a button configuration system. Scale plans to the task.

- **Smallest *correct* diff.** "Smallest" never means dropping correctness, needed validation, or performance — it means not adding code that earns nothing. If a change adds a lot of lines, say in one sentence why a smaller approach won't work. Delete dead code you find on the way; net-negative diffs are a good outcome.
- **Reuse before you write.** Before adding a helper, hook, component, or util, `grep`/Glob for one that already does it and extend that. Duplicated logic is the #1 source of AI codebase bloat — copy-paste is not cheaper than reuse, it's debt.
- **No time estimates.** Never attach hours, days, weeks, or sprints to a task or phase ("~2 hours", "Phase 1: 3 days"). These come from human work-pace in the training data, not agent execution speed — false precision that wrongly shrinks scope to fit a made-up clock. Sequencing ("do X before Y") is fine; durations are not.
- **Tests must assert something real.** One meaningful assertion beats five that restate the implementation.

## Commands

```bash
npm run dev          # Start dev server at localhost:3000
npm run build        # Production build
npm run lint         # ESLint (flat config)
npm run typecheck    # TypeScript type checking (tsc --noEmit)
npm run test         # Unit tests (Vitest, jsdom)
npm run test:watch   # Tests in watch mode
npx vitest run src/__tests__/scoring.test.ts  # Run a single test file
npm run e2e          # Playwright e2e (needs local Supabase + .env.test)
bash infra/app/deploy-to-prod.sh  # Deploy to GCP Cloud Run (must be on main, clean tree)
```

**npm only — never use yarn (or pnpm/bun).** `package-lock.json` is the single lockfile; `yarn.lock` was removed after the two drifted, and the Dockerfile builds with `npm ci`. Install with `npm install`, add packages with `npm install <pkg>`, run scripts with `npm run <script>`. If a `yarn.lock` ever reappears, delete it.

CI runs lint → typecheck → build → test on every push/PR to main.

## Architecture — Non-Obvious Rules

**Auth redirects happen ONLY in `src/middleware.ts`**. Pages and layouts must never redirect for auth — this prevents redirect loops.

`const supabase = await createClient()` — the server-side Supabase client (`src/lib/supabase/server.ts`) must be awaited in Next.js 16. Forgetting `await` causes cryptic runtime errors.

`src/lib/supabase/types.ts` is auto-generated. Do not edit manually.

**Supabase joins** return single relations as either object or array depending on context. Use the `resolveJoin()` pattern: `(val) => Array.isArray(val) ? val[0] : val`.

Each feature page has a co-located `actions.ts` with `'use server'` functions. Server components fetch data; client components call server actions for mutations. Actions return `{ error: 'message' }` or `{ success: true }` — never throw. Every server action that mutates data must follow this sequence: `getAuthUser() → verifyOwnership/Enrollment → createAdminClient() → DB op → logEvent() → revalidatePath()`. Use `logEvent()` from `src/lib/supabase/event-logger.ts` for all mutations — it feeds analytics and audit logs.

**Multi-tenant safety**: all tenant-scoped writes must include `institution_id` (forgetting this leaks data across institutions). See **Security** for the RLS policies that enforce this at the DB layer.

All DB query functions live in `src/lib/supabase/queries.ts`, take a `SupabaseClient` as first param, catch errors internally, and return safe fallbacks (null, [], 0).

**Logging**: Use `logger.error/warn/info/debug()` from `@/lib/logger` for all persistent logging — never commit raw `console.log`. However, during active development, freely add `console.log` statements to debug issues faster and reduce iteration turns. Before committing, clean up: remove all `console.log` calls or convert them to proper `logger` calls if they have long-term value. Levels `error`/`warn`/`info` ship to production, `debug` is dev-only. Source format: `ComponentName.methodName`.

Supabase migrations live in `supabase/migrations/`. **Name new migrations with `supabase migration new <name>` (timestamp prefix) — never hand-number a sequential `0000…NN` file.** Parallel branches grabbing the same next integer is a recurring collision (two `069`s → Postgres keys a migration by its leading number, so one is silently skipped). See **Security** for the RLS requirement on every table.

## Security — Non-Negotiable

**IMPORTANT: This stack (Next.js + client-reachable Supabase + RLS-based multi-tenancy) is the exact architecture behind the largest AI-shipped-code breaches. A violation is a data-leak bug, not a nit.** Four invariants — kept always-loaded because a path-scoped rule only fires once you open a matching file:

- **RLS on every table** — enabled in the same migration that creates it, scoped by `institution_id` AND role.
- **Secrets never reach the client** — no `service_role`/API key/DB credential in any `'use client'` tree, no `NEXT_PUBLIC_*` secret, and never logged.
- **Verify ownership before every mutating DB op** — assume every action/route is called unauthenticated by an attacker; the client is untrusted.
- **Dependencies** — never add an npm package you haven't confirmed is real (real publisher + download history); if unsure, STOP and ask (slopsquatting).

When a security rule conflicts with brevity or speed, the security rule wins; if you cannot satisfy one, STOP and flag it rather than shipping around it.

The enforceable, file-specific checklists — the full authz sequence, RLS/policy specifics, secrets, XSS, and concurrency/idempotency/perf — live in `.claude/rules/security-server-actions.md`, `security-client.md`, `security-migrations.md`, and `data-access.md`, auto-loaded when you edit the files they govern.

## Vector Search — Pinecone

**Pinecone (serverless) is the team's vector database — already configured.** Any embeddings/RAG/semantic-search work uses it; never add pgvector or another vector store. Pinecone has **no RLS** — application code is the tenant boundary, so its rules carry Security-section severity:

- All access through the single server-only wrapper `src/lib/pinecone/`; every call takes `institutionId` from the authenticated session and derives the namespace internally. The default namespace stays empty.
- `PINECONE_API_KEY` is server-only — same treatment as `service_role`.
- Supabase Postgres stays the source of truth; vectors are a rebuildable projection.

The full conventions (IDs, metadata whitelist, embedding-model pinning, sync, retrieval profiles, eval gate) live in `.claude/rules/vector-db.md` — auto-loads when editing vector code; **read it before designing any vector feature**, since index-creation choices (metric, dimension, region) are immutable.

## Conventions

Key rules Claude wouldn't infer from code alone:
- **Server components by default** — only add `'use client'` when hooks, event handlers, or browser APIs are needed
- shadcn style: new-york, neutral base. Add components via `npx shadcn@latest add [name]`
- **UI anti-patterns**: no raw Tailwind color classes, no custom CSS files, radius classes only — see `.claude/rules/ui-design.md` (loads on frontend edits) for the full rules.
- **Dead ends**: unreachable routes call `notFound()`, role-area denials render `<DeadEnd variant="no-access">` — never a bare 404, a blank `return null`, or a silent redirect. See `.claude/rules/dead-ends.md` (loads on frontend edits) for toast-vs-404 and the tenant-safe copy rules.
- After significant feature changes, update the relevant `CONTEXT.md` — and `docs/onboarding/guide/` when the change invalidates it (a route/feature/table added or removed, a command or env var changed, an architectural pattern introduced). Update only the affected guide file; don't regenerate the set.
- **Documentation style**: no AI-sounding filler in any `.md` file, code comment, commit message, or PR description — see `.claude/rules/documentation-style.md` (auto-loads on markdown edits; the same standard applies to comments/commits/PRs too, so consult it there even though it won't auto-load).

## Team Workflow

### System Design First

**IMPORTANT: For non-trivial work (new feature, new page, or multi-file change), produce a one-page system design BEFORE writing implementation code.** Use the `mermaid` skill to sketch a first-pass diagram of the feature, then refine it with the developer — Claude sketches, the human shapes — and get their sign-off before coding. Follow the standard and template in `docs/reference/system-design-rules.md`, and save the design into the matching feature folder under `docs/designs/` — never at its root (`docs/designs/README.md` lists the clusters and the required status header). Small fixes (typo, one-liner, config tweak) skip this step.

### Branching

**IMPORTANT: Never commit directly to `main` for feature work.** Multiple people work in this codebase. The rule:

- **Major features / new pages / multi-file changes** → create a feature branch (`feature/short-description` or `fix/short-description`) off `main` before starting work. Ask which branch to use if unclear.
- **Small fixes** (typo, one-liner, config tweak) → commit to the current working branch (e.g. `staging`), not `main`.
- Before writing any code for a new feature, check `git branch` and confirm you are NOT on `main`. If you are, create and switch to a feature branch first.

Branch flow: `feature branch` → `main` → deploy.

### Pre-Commit Gates

**IMPORTANT: Every commit MUST pass through this sequence. Do not skip steps.**

**Step 0 — Scope the gates to the diff.** If every changed file is documentation (`*.md`, anything under `docs/`, images), skip Step 1 and Step 2 entirely and just commit — markdown can't break lint, types, tests, or security. Any code, config, or migration change → run the full sequence.

**Step 1 — Fix lint and typecheck (blocking, scoped to the change).** Both checks run scoped, not repo-wide — full-repo runs waste time and RAM on this machine:

- **Lint only the changed files:** `npx eslint $(git diff --cached --name-only --diff-filter=d | grep -E '\.(ts|tsx|js|mjs)$')` — sound to scope, since ESLint rules are per-file. Skip if no lintable files changed.
- **Typecheck only when the diff touches `.ts`/`.tsx` (or `tsconfig.json`/`package.json`)** — but then run the full `npm run typecheck`, never `tsc` on individual files: per-file `tsc` ignores `tsconfig.json` and misses breakage in files that *import* the changed one, so a scoped run gives false passes. The saving comes from skipping it when no TS changed, not from narrowing it.

Fix ALL errors and warnings before proceeding. Do not commit with warnings — treat them as errors. Never silence a failure to make it pass — no empty catch blocks, `any` casts, `eslint-disable`, or `@ts-ignore` to suppress errors. Fix the root cause. (Pre-existing failures in untouched files aren't yours to fix in this commit — flag them, don't block on them.)

**Step 2 — Run review agents (parallel, in background).** Only after step 1 passes cleanly:

- **UX Reviewer** (frontend changes only — `.tsx`, `.jsx`, `.css`, anything under `src/components/` or `src/app/`): Launch the `ux-reviewer` agent in background. It reviews UI/UX quality — button sizing, spacing, accessibility, visual hierarchy, interaction patterns, consistency with design system. Apply its findings before committing.
- **Test Case Guardian** (every commit): Launch the `test-reviewer` agent in background. It analyzes staged changes to determine: (a) do new features need new tests? (b) do existing tests need updating to account for the changes? It does NOT always generate tests — it evaluates first.
- **Security Reviewer** (every commit touching `src/` or `supabase/`): Launch the `security-reviewer` agent in background. It audits staged changes for the vulnerability classes that breach this stack — broken access control / IDOR, missing RLS, secrets reaching the client, XSS/injection, risky dependencies — and returns a BLOCK / GOOD TO COMMIT verdict. Resolve all 🔴 Critical and 🟠 Major findings before committing.

These agents run in background so you can address findings as they come in. Commit only after all applicable agents complete and their findings are resolved.

**These gates run only when Claude performs the commit.** When changes are ready, prefer letting Claude commit so the gates (security, tests, UX) run first. If the developer is about to commit manually and skip them, remind them **once** that these checks catch security/test/UX regressions and are easy to bypass by accident — then respect their decision. Strong default, not a hard block.

### Pull Requests

- PR bodies lead with *why*, point the reviewer at what to scrutinize, and give verification **evidence** (not just "tests pass").
- When a feature PR is complete and ready for review, add the `review:harshil` label to route it to Harshil (add it only when ready).

### Deployment

Production deploys to Google Cloud Run. The deploy script (`infra/app/deploy-to-prod.sh`) enforces: must be on `main`, no uncommitted changes, lint and typecheck must pass. Docker build uses `output: 'standalone'` from Next.js.

**Infrastructure choices**: We run on GCP (Cloud Run). When a feature needs infrastructure **not already covered by Supabase or Next.js** — async/background jobs, scheduled work, long-running or heavy processing, queues, pub/sub — surface the GCP-native option (Cloud Tasks, Cloud Scheduler, Cloud Run Jobs, Pub/Sub) as a candidate in design discussion, since we already operate there. Default to Supabase / a server action / a Next.js route when those already do the job — suggest GCP only when it's the better fit.

## Testing

- Unit tests in `src/__tests__/` using Vitest with jsdom environment
- Coverage thresholds live in `vitest.config.ts` and CI runs `npm run test:coverage`, so they block a merge rather than just being documented: `quiz/scoring.ts` (95% lines), `quiz/analytics-utils.ts` (95%), `live-classroom/attendance/actions.ts` (100% lines + branches)
- E2e tests in `e2e/tests/` using Playwright against local dev server + local Supabase
- Visual tests in `e2e/visual/` — one markdown walkthrough per feature, executed live via the Chrome DevTools MCP browser (see `e2e/visual/README.md`). New non-trivial UI features should get one.
- Test setup: `src/__tests__/setup.ts`

## Feature Toggles

`course_sections.settings` carries three independent keys. `enabledFeatures` = what **students** see (and the gate behind `verifyFeatureEnabled`). `sidebarHidden` + `sidebarOrder` = the **professor's own** nav. They are deliberately decoupled: the professor sidebar lists every feature by default, so **never re-filter it on `enabledFeatures`** — a feature being in the professor's nav does not mean students can reach it. Student-facing features a professor has enabled must never be hidden by default in code — respect the toggle.

## Learned Mistakes

Rules added from real mistakes. When Claude repeats a mistake, add it here — but only if the rule isn't already stated in Architecture, Security, or Conventions above (don't duplicate; this section is for *new* gotchas not covered elsewhere). This is important so that Claude does not make the same mistakes over and over.

- **Never run `npm run build` while `next dev` is running.** Both write to `.next/`; the dev server then serves corrupted artifacts (e.g. stylesheets silently missing whole CSS blocks while components stay current). Recovery: kill dev, `rm -rf .next`, restart.
- **Vitest 4: never touch a mock in `beforeEach` when its implementation throws.** `beforeEach(() => myMock.mockReset())` (or `mockClear`) makes vitest mis-attribute errors thrown by the mock's implementation — even ones CAUGHT by the code under test — as test failures with the raw error message. The same `mockClear()` INSIDE the test body is fine. Observed on vitest 4.1.9; see `src/__tests__/llm-quiz-dedup-types.test.ts` header comment.
