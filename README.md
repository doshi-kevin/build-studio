# Scholera

Scholera is a learning management system with AI built into the core instead of bolted on top.
Professors use it to build and run courses. Students use it to do the coursework, take quizzes,
and ask questions of an AI tutor that only knows their course material.

Backed by NJ Plug and Play. First pilot at Stevens Institute of Technology.

**New here?** Read [`docs/onboarding/guide/`](docs/onboarding/guide/) first. It takes you from
"what is this" to shipping your first change. This file is just the front door.

## How it fits together

One Next.js app serves every page and API route. Supabase is the database, auth, file storage,
and realtime layer. The whole thing builds into a single Docker image and runs on Google Cloud Run.

It is multi-tenant: an institution contains professors, students, staff, and admins, and a user
should never see another institution's data. Postgres row-level security enforces that, so most
rules live in the database rather than in app code.

| Layer | What we use |
|---|---|
| Framework | Next.js 16 (App Router, standalone output) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4, shadcn/ui, Radix UI |
| Database | Supabase (Postgres, Auth, Storage, Realtime) |
| AI | Vercel AI SDK with Google Gemini, OpenAI, Groq |
| Rich text | TipTap / Novel |
| Charts | Recharts |
| 3D | Three.js (React Three Fiber) |
| Testing | Vitest (unit), Playwright (end-to-end) |
| Hosting | Google Cloud Run (Docker) |
| Email | Resend (scholera-inc.com) |

## What it does

**Professors** generate courses with AI, organize modules and content, build quizzes (question
bank, adaptive difficulty, negative marking, formula sheets, leaderboards), run Live Classroom
sessions with live polls and Q&A, grade through a gradebook that flags at-risk students, manage
team projects, edit a visual course roadmap, post announcements, and keep a calendar and office
hours.

**Students** browse and enroll in courses, ask the AI tutor about their own materials, take
quizzes with a timer and auto-save, see grades broken down by topic, keep materials in a personal
library, collaborate on team projects, message classmates, and follow the course roadmap.

**Admins** manage departments, professors, courses, and programs, oversee enrollment, customize
page themes, and turn features on or off per section.

## Getting started

You need Node.js 22 (see `.nvmrc`), npm 10 or newer, and access to a Supabase project.

```bash
git clone <repo-url>
cd scholera-web
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev
```

The app runs at http://localhost:3000.

Use npm, not yarn or pnpm. `package-lock.json` is the only lockfile and the Docker build
runs `npm ci`.

### Environment variables

`.env.example` has the full list with descriptions. These are the ones the app will not start
without:

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key (safe in the browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server only, never send to the browser) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini key, which every AI feature runs on. This exact name only; `GEMINI_API_KEY` and `GOOGLE_API_KEY` are ignored. |
| `RESEND_API_KEY` | Resend key, for email |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm run test` | Unit tests (Vitest) |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:coverage` | Unit tests with coverage |
| `npm run e2e` | End-to-end tests (Playwright) |
| `npm run e2e:ui` | End-to-end tests with the Playwright UI |

Do not run `npm run build` while `npm run dev` is running. They share `.next/` and the dev
server will start serving corrupted files.

## Where things live

```
src/app/          Pages and API routes. (auth) is login/signup, (dashboard) is
                  everything behind a login, split by role: admin, professor,
                  student, staff, super-admin.
src/components/   React components. ui/ is shadcn primitives; the rest are grouped
                  by role or feature.
src/lib/          Non-UI logic, grouped by domain: supabase/ (client and queries),
                  ai/, quiz/, live-classroom/, extraction/, validations/, and more.
src/__tests__/    Unit tests.
supabase/         Database migrations. See supabase/README.md.
infra/            Deploy scripts for Cloud Run. See infra/README.md.
docs/             Documentation. Start at docs/README.md.
e2e/              Playwright tests and browser walkthroughs. See e2e/README.md.
scripts/          Local setup and one-off tooling. See scripts/README.md.
.github/          CI and Dependabot config. See .github/README.md.
```

For the complete file-by-file map, see
[`docs/onboarding/guide/4-visual-tree.md`](docs/onboarding/guide/4-visual-tree.md).

Two conventions worth knowing before you open a file. Auth redirects happen only in
`src/middleware.ts`, never in a page or layout, because page-level redirects cause loops. And
each feature folder keeps its own `actions.ts` of server actions, so mutations live next to the
page that calls them.

## Database

Supabase Postgres. Migrations are in `supabase/migrations/`. Create new ones with
`supabase migration new <name>` so they get a timestamp prefix; never hand-number a file, because
two branches picking the same number means one silently never runs.

Every table needs row-level security enabled in the same migration that creates it.

## Deploying

```bash
bash infra/app/deploy-to-prod.sh
```

The script refuses to run unless you are on `main` with a clean tree and lint plus typecheck
pass. It deploys the app only. Database migrations are applied separately.

Branch flow: feature branch, then `main`, then deploy. Do not commit feature work straight
to `main`.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, coding conventions, and component guidelines.
`CLAUDE.md` holds the rules that are not obvious from reading the code, including the security
invariants. Read those before your first pull request.
