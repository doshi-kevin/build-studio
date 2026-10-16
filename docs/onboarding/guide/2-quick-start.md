# 🚀 Quick Start Guide

> Get Scholera running locally, against a safe local database with realistic dummy data — zero production access needed.

## 🎯 What You'll Have at the End

- The full Scholera app running at `http://localhost:3000`
- A **local Supabase stack** (Postgres + Auth + Storage + Realtime) with the current production **schema** replayed from migrations
- The **Scholera Dev** dummy institution seeded with courses, sections, users, enrollments, quizzes, and announcements
- Working dev logins for every role (admin, professor, students)

## ✅ Prerequisites

### Required

- [ ] **Node.js 22+** — check with `node --version` (see `.nvmrc`)
- [ ] **npm 10+** — check with `npm --version`. **npm only — never yarn/pnpm/bun.** `package-lock.json` is the single lockfile and the Docker build uses `npm ci`.
- [ ] **Docker Desktop** (installed *and running*) — the local Supabase stack runs in Docker. Install: https://docs.docker.com/desktop
- [ ] **Git** access to the repo (org: `Scholera-Inc`)

> 💡 You do **not** need to install the Supabase CLI globally — it's a devDependency, invoked via `npx supabase`.

## 📝 Step-by-Step Instructions

### Step 1: Clone and Install

```bash
git clone <repo-url>
cd Scholera-prod

# npm only — never yarn
npm install
```

You should see `src/`, `supabase/`, `scripts/`, `docs/` when you `ls`.

### Step 2: Set Up Environment Variables

```bash
cp .env.example .env.local
```

For **local development** (the default for new contributors), point the app at the local stack:

```bash
# .env.local — minimum to boot the app locally
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from `npx supabase status`>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from `npx supabase status`>
```

The anon and service-role keys are printed by `npx supabase status` once the stack is up (Step 3 starts it for you — you can come back and fill these in after).

Everything else in `.env.example` is **feature-scoped** — the app boots without it, but the matching feature won't work:

| Variable(s) | Feature that needs it |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Every AI feature (Athena, quiz generation, AI tutor, rubric drafting, AI grading). This exact name only: `GEMINI_API_KEY` and `GOOGLE_API_KEY` are ignored. `OPENAI_API_KEY` is **not** used by the app. |
| `PINECONE_API_KEY`, `PINECONE_INDEX_MATERIALS` | AI search, the student tutor's retrieval, rubric reference lookup |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional email (invites, notifications) |
| `ELEVENLABS_API_KEY` | Pre-class audio generation |
| `GOTENBERG_URL` | Live Classroom deck (PPTX/PDF) conversion |
| `EXTRACTION_WORKER_SECRET` / `_KICK_URL`, `BACKGROUND_JOBS_SECRET` / `_KICK_URL` | Background extraction & job workers |
| `SLACK_WEBHOOK_URL`, `SLACK_FEEDBACK_WEBHOOK_URL` | Slack notifications / feedback forwarding |
| `TEST_*` | Playwright e2e test logins |
| `STUDIO_RUNTIME_ORIGIN`, `STUDIO_FRAME_TICKET_SECRET` | Studio plugin frames. The runtime origin must be a different site from the app: locally `http://127.0.0.1:3000` while you browse on `localhost:3000`. Unset means plugin frames are off |
| `STUDIO_BUILDER_RENDERER`, `STUDIO_BUILDER_RENDERER_ROOT` | `local` lets the Studio builder screenshot its drafts for the design review, using Playwright's Chromium on this machine. Refused in a production build unless the database is on loopback. The root is the repository path, needed when the server runs from a standalone build. Unset means the review reads the code only |
| `STUDIO_STUDENT_ACCESS` | `on` lets students open Studio plugins their professor has shown them. Anything else keeps students out. Off in production until the release gate in `docs/reference/studio-plugin-publication.md` passes. Studio also needs the `studio` entitlement, which no institution has by default: grant it in the super-admin plan editor |
| `STUDIO_VALIDATOR_RUNNER`, `STUDIO_VALIDATOR_RUNNER_ROOT` | `local` runs the Studio validator's browser checks on your machine, using Playwright's Chromium (`npx playwright install chromium`). Refused in a production build unless the database is on loopback, as on the guarded local server (`e2e/serve-guarded.mjs`). `cloud` sends them to the Cloud Run job instead and needs the five other `STUDIO_VALIDATOR_*` settings listed in `infra/validator-runner/README.md`. The root is the repository path, needed when the server runs from a standalone build. Unset means the browser checks can't run, so no plugin can be shown to students |

⚠️ **Never** put a real `service_role` key or any secret in a `NEXT_PUBLIC_*` variable — those are inlined into the client bundle.

### Step 3: One-Command Local Database Setup

```bash
./scripts/dev-setup/setup-local.sh
```

This script (read `scripts/dev-setup/CONTEXT.md` for the full story):

1. **Preflight-checks** Docker → Docker daemon → Supabase CLI, printing the exact fix if anything's missing
2. **Auto-starts** the local Supabase stack (first run pulls Docker images — can take a few minutes)
3. Runs `supabase db reset` — replays **all migrations** in `supabase/migrations/`, so your local schema matches production
4. Runs `seed-dev.ts` — creates the storage buckets migrations don't (`course-materials`, `proctoring-snapshots`) and seeds the **Scholera Dev** institution with dummy data
5. **Prints the dev logins** at the end

It is hard-gated to `localhost` — it physically cannot touch production.

> ⚠️ Re-running it **wipes and rebuilds your local database**. That's by design (fresh schema + fresh seed), but don't run it if you have local data you care about.

### Step 4: Run the App

```bash
npm run dev
```

Open **http://localhost:3000** — you should see the Scholera landing page.

### Step 5: Log In and Verify

Signup is disabled (Scholera is invite-only), so use the seeded dev logins printed by `setup-local.sh`:

- `admin@scholera.dev` — institution admin
- `professor@scholera.dev` — professor
- `student1@scholera.dev` … `student6@scholera.dev` — students

Verify it works:

1. **Log in as the professor** → you land on the professor dashboard with seeded courses
2. **Open a course** → tabs for Modules, Quizzes, Assignments, Announcements, etc.
3. **Log in as a student** (different browser/incognito) → student dashboard with enrollments
4. **Open Supabase Studio** at http://127.0.0.1:54323 to browse the database directly

## 🔧 Troubleshooting

### Port 3000 already in use
```bash
lsof -i :3000        # find the process
kill -9 <PID>        # kill it, or: PORT=3001 npm run dev
```

### "supabase start failed"
Usually Docker is out of memory or disk. Open Docker Desktop → Settings → Resources, give it more, then re-run `./scripts/dev-setup/setup-local.sh`.

### App loads but data "doesn't exist" / login fails with a 400
Check for a leftover `.env.development.local` — it **overrides** `.env.local`, so you may silently be pointed at a different database than you think. Delete it if you didn't create it on purpose.

### AI features fail but everything else works

Athena and rubric generation both refuse while the rest of the app is fine. Three causes, cheapest check first.

**1. Your Gemini key can't see the preview models.** `src/lib/ai/config.ts` pins `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, and `gemini-3.1-flash-lite-preview`. A key without preview access gets 404 on all of them while a hand-rolled curl against a stable model like `gemini-2.5-flash` still succeeds, so "I tested the API and it works" does not rule this out. List what your key can actually see:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$KEY&pageSize=1000" | grep -o 'models/gemini-3[^"]*'
```

**2. The key isn't reaching the server.** It must be named `GOOGLE_GENERATIVE_AI_API_KEY`; the Google provider ignores every other spelling. Restart `next dev` after editing `.env.local`, and check for a leftover `.env.development.local` that overrides it.

**3. Your database is missing the AI kill switch table.** `checkAiFeature` reads `platform_settings` and is fail-closed on purpose, so if that table is absent every AI call is refused before a token is spent. You'll see "AI features are temporarily unavailable." Check with `select * from platform_settings;` in Studio. If it errors, your migrations are behind: re-run `./scripts/dev-setup/setup-local.sh` (this wipes local data).

Rubric generation swallows the provider error and shows "Could not generate a rubric." The real cause is only in the `next dev` terminal, logged from `generateRubricFromText`. Watch that terminal while you click generate. For Athena, the response body in the network tab names it directly (`ai_disabled`, `not_entitled`, `athena_rate_limited`).

### Styles look broken / pages serve stale code
Never run `npm run build` while `next dev` is running — both write to `.next/` and corrupt each other. Recovery:
```bash
# kill the dev server, then:
rm -rf .next
npm run dev
```

### A migration fails during `db reset`
The newest migration is probably broken, or the seed no longer matches the schema. `setup-local.sh` fails loudly on purpose — whoever wrote the breaking migration updates `scripts/dev-setup/seed-dev.ts` in the same PR. Flag it on the team channel.

### `Cannot find module '...'`
```bash
rm -rf node_modules package-lock.json && npm install
```
(Only do this if a plain `npm install` didn't fix it — and never switch to yarn.)

## 🎨 Try Your First Change

1. Open `src/app/page.tsx` (the public landing page)
2. Find the hero heading text and tweak a word
3. Save — the browser hot-reloads and you see your change immediately
4. Revert it: `git checkout src/app/page.tsx`

Then run the checks every PR must pass:

```bash
npm run lint
npm run typecheck
npm run test
```

## 🌍 Other Environments

- **Hosted staging** — `staging.scholera-inc.com`, its own isolated Supabase project (never prod). Deployed via `infra/app/deploy-to-staging.sh`.
- **Production** — Google Cloud Run, deployed via `infra/app/deploy-to-prod.sh` (must be on `main`, clean tree, lint+typecheck pass). **You never apply migrations to prod** — you write the migration file; an admin applies it at release time.
- **E2E** — `npm run e2e` runs Playwright against a local dev server + local Supabase (needs `.env.test`; see `e2e/playwright.config.ts`). Two Studio suites need neither: `npm run e2e:studio-runtime` (plugin sandbox isolation in three browsers) and `npm run e2e:studio-validator` (the validator's browser checks on known-good and broken plugins).

## ❓ FAQ

**Q: How do I reset everything and start fresh?**
Re-run `./scripts/dev-setup/setup-local.sh` — it wipes and rebuilds the local DB. For node modules: `rm -rf node_modules && npm install`.

**Q: Can I develop against the production database?**
No. New contributors develop only against the local stack. The seed and setup scripts are hard-gated to localhost, and this is a team rule, not just tooling.

**Q: I need a schema change. What do I do?**
Create it with `npx supabase migration new <name>` (never hand-number a file), write the SQL (RLS in the same migration that creates any table), then re-run `setup-local.sh` to prove it replays cleanly. Open a PR with the migration — an admin applies it to prod.

**Q: Where do I see emails sent locally?**
Inbucket, the local mail-catcher: http://127.0.0.1:54324.

## 📋 Quick Reference

```bash
npm run dev          # dev server → localhost:3000
npm run build        # production build
npm run lint         # ESLint (flat config)
npm run typecheck    # tsc --noEmit
npm run test         # unit tests (Vitest)
npm run test:watch   # tests in watch mode
npm run e2e          # Playwright e2e (needs local Supabase + .env.test)
npm run e2e:studio-runtime    # Studio plugin sandbox, 3 browsers, no database
npm run e2e:studio-validator  # Studio validator browser checks, no database
./scripts/dev-setup/setup-local.sh   # rebuild local DB + seed
npx supabase status  # local stack URLs + keys
```

### Default Ports & URLs

| Service | URL |
|---|---|
| App | http://localhost:3000 |
| Supabase API | http://127.0.0.1:54321 |
| Postgres | 127.0.0.1:54322 |
| Supabase Studio | http://127.0.0.1:54323 |
| Inbucket (local email) | http://127.0.0.1:54324 |

## 📚 Next Steps

- **Understand the structure** → [4-visual-tree.md](./4-visual-tree.md)
- **Learn the architecture** → [5-architecture.md](./5-architecture.md)
- **Explore key files** → [6-file-insights.md](./6-file-insights.md)
- **Learn the team workflow** → [7-development.md](./7-development.md)
