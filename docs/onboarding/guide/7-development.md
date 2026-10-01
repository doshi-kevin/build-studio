# 💻 Development Guide

> How to build, test, and ship a change in this repo — the mechanics. For coding rules the repo enforces, `CLAUDE.md` (repo root) is canonical.

## 🔁 The Daily Loop

```bash
git pull                              # newest migrations + seed
./scripts/dev-setup/setup-local.sh    # only when migrations changed (wipes local DB)
npm run dev                           # localhost:3000, hot reload
# ...build...
npm run lint && npm run typecheck && npm run test
```

## 🌿 Branching

**Never commit feature work directly to `main`.**

- **Features / new pages / multi-file changes** → branch off `main`: `feature/short-description` or `fix/short-description`
- **Small fixes** (typo, one-liner, config tweak) → commit to the current working branch
- Flow: `feature branch` → PR → `main` → deploy

## 🧭 Where Code Goes

| What you're adding | Where it lives |
|---|---|
| A page | `src/app/(dashboard)/<role>/.../page.tsx` — server component by default |
| A mutation | Co-located `actions.ts` next to the page (`'use server'`) |
| A DB query (read) | `src/lib/supabase/queries.ts` — takes a `SupabaseClient` first param, catches errors, returns safe fallbacks |
| Domain/business logic | `src/lib/<domain>/` (40+ existing domains — extend, don't duplicate) |
| A shared component | `src/components/<area>/`; shadcn primitives in `src/components/ui/` via `npx shadcn@latest add <name>` |
| A schema change | `supabase/migrations/` via `npx supabase migration new <name>` — **never hand-number a file** |
| Input validation | `src/lib/validations/` (Zod schemas) |

Key conventions (full rules in `CLAUDE.md` and `.claude/rules/`):

- **Server components by default** — `'use client'` only for hooks, event handlers, browser APIs
- `const supabase = await createClient()` — the server client **must be awaited** (Next.js 16)
- Server actions return `{ error: 'message' }` or `{ success: true }` — never throw
- Every mutating action: authenticate → verify ownership/enrollment → admin client → DB op → `logEvent()` → `revalidatePath()`
- All tenant-scoped writes include `institution_id` — forgetting it leaks data across institutions
- Logging via `logger.error/warn/info/debug()` from `@/lib/logger` — no committed `console.log`
- shadcn style: new-york, neutral base; no raw Tailwind color classes; no custom CSS files
- **npm only** — never yarn/pnpm/bun

## 🔒 Security Is a Blocking Gate

This stack (Next.js + client-reachable Supabase + RLS multi-tenancy) is exactly where real-world data-leak breaches happen. Four non-negotiables:

1. **RLS on every table**, enabled in the same migration that creates it, scoped by `institution_id` AND role
2. **Secrets never reach the client** — no `service_role`/API keys in any `'use client'` tree or `NEXT_PUBLIC_*` var
3. **Verify ownership before every mutating DB op** — assume every action is called by an attacker
4. **Never add an npm package you haven't verified is real** (publisher + download history)

File-specific checklists live in `.claude/rules/security-server-actions.md`, `security-client.md`, `security-migrations.md`, and `data-access.md`.

## 🧪 Testing

| Layer | Where | Command |
|---|---|---|
| Unit (Vitest, jsdom) | `src/__tests__/` (449 files) | `npm run test` / `npm run test:watch` |
| Single file | | `npx vitest run src/__tests__/scoring.test.ts` |
| Coverage | | `npm run test:coverage` |
| E2E (Playwright) | `e2e/tests/` (7 specs, chromium only) | `npm run e2e` (needs local Supabase + `.env.test`; seed via `npm run db:seed:e2e`) |
| Visual walkthroughs | `e2e/visual/` | Markdown scripts executed live in a browser — see `e2e/visual/README.md` |

- Test setup/mocks: `src/__tests__/setup.ts` (includes a reusable Supabase Realtime `mockChannel` for broadcast-hook tests)
- Enforced coverage thresholds (`vitest.config.ts`): `src/lib/quiz/scoring.ts` (95% lines / 90% branches) and `src/lib/quiz/analytics-utils.ts` (95% lines) — the two most correctness-critical grading modules
- Tests must assert something real — one meaningful assertion beats five restating the implementation
- New non-trivial UI features should get a visual walkthrough in `e2e/visual/`

## 🗄️ Database Changes

1. `npx supabase migration new <name>` — creates a timestamped file in `supabase/migrations/`
2. Write the SQL. If it creates a table: **enable RLS + policies in the same migration**. Policies use `DROP POLICY IF EXISTS` before `CREATE POLICY` (Postgres has no `CREATE POLICY IF NOT EXISTS`)
3. `./scripts/dev-setup/setup-local.sh` — prove the full migration chain replays cleanly
4. If your migration breaks the seed, fix `scripts/dev-setup/seed-dev.ts` in the same PR
5. Open the PR. **An admin applies the migration to prod** — you never do
6. `src/lib/supabase/types.ts` is auto-generated from the schema — never edit it by hand

## ✅ Pre-Commit / Pre-PR Checklist

CI runs **lint → typecheck → build → test** on every push/PR to `main` (`.github/workflows/ci.yml`, Node from `.nvmrc`, ~20 min cap). Locally, before you push:

```bash
npm run lint        # zero errors AND zero warnings — warnings are treated as errors
npm run typecheck
npm run test
npm run build       # if you touched build-relevant config
```

Never silence a failure to make it pass — no empty catches, `any` casts, `eslint-disable`, or `@ts-ignore`. Fix the root cause. (Pre-existing failures in files you didn't touch: flag them, don't block on them.)

If you use Claude Code, three review agents run before commits (`.claude/agents/`): `ux-reviewer` (frontend changes), `test-reviewer` (every commit), `security-reviewer` (anything touching `src/` or `supabase/`). Let Claude perform the commit so the gates run.

## 🔀 Pull Requests

- PR bodies lead with *why*, point the reviewer at what to scrutinize, and give verification **evidence** — not just "tests pass"
- When a feature PR is ready for review, add the `review:harshil` label
- Other workflows in `.github/workflows/`: `extraction-sweep.yml` / `jobs-sweep.yml` (worker sweeps), `mastery-recompute-nightly.yml` (nightly skill-mastery recompute)

## 🚀 Deployment

- **Production**: `bash infra/app/deploy-to-prod.sh` — Docker build (Next.js `output: 'standalone'`) → Google Cloud Run. The script enforces: on `main`, clean tree, lint + typecheck pass, and asks for confirmation
- **Staging**: `infra/app/deploy-to-staging.sh` → `staging.scholera-inc.com`, backed by its own isolated Supabase project
- The deploy script ships **app code only** — schema changes are applied to prod separately by an admin
- Before any prod deploy: confirm all migrations on `main` are applied to prod, and check the merged diff for new `process.env` vars that must be set on Cloud Run first
- Infra details: `infra/README.md`; the deck-converter microservice lives in `infra/microservices/deck-converter/`

## 📝 Documentation Duties

- Changed feature behavior? Update the nearest `CONTEXT.md` (they live throughout `src/`)
- Made an architectural decision? Add an entry to `docs/archive/decisions.md`
- Non-trivial feature? It starts with a system design (`docs/designs/`, per `docs/reference/system-design-rules.md`)

## 🧠 Engineering Philosophy

Do not over-engineer; do not under-engineer. Ask **"what is the simplest thing that solves this correctly?"** — build that, stop.

- **Smallest correct diff** — never at the cost of correctness, validation, or performance; delete dead code you find on the way
- **Reuse before you write** — grep for an existing helper/hook/component before adding one; duplication is debt
- Products decisions tie-break toward the users in `docs/reference/user-signals.md`: professors pay to save time, ~15% ever explore new LMS features (put features in flows they're already in), students want less overhead — not another system to learn

## 📚 Related Guides

- [2-quick-start.md](./2-quick-start.md) — environment setup from zero
- [5-architecture.md](./5-architecture.md) — how the system fits together
- [3-concepts.md](./3-concepts.md) — domain vocabulary and core patterns
