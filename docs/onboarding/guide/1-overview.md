# 🎯 Project Overview

> The 5-minute understanding of what Scholera is, why it exists, and where to start.

## 🎯 What Is This?

Scholera is an **AI-native learning management system (LMS)** built to replace Canvas. Think of it as the LMS rebuilt from scratch with AI as a foundation instead of a plugin: professors build courses, run live classroom sessions, author interactive assignments and quizzes, and grade — with an AI assistant (**Athena**) woven into every one of those flows; students get one place for what's due, an AI tutor grounded in their actual course materials, and post-class study packs. It's multi-tenant (institutions contain professors, students, staff, and admins), piloting at Stevens Institute of Technology, and launching US-wide for 30,000+ students.

## 🤔 What Problem Does It Solve?

**The Problem:** Legacy LMSs (Canvas, Blackboard — built ~2011) treat AI as a bolt-on. Professors are time-poor — building a course takes ~40 hours of clicking through forms; students juggle logistics across several courses in systems that feel like enterprise software from another decade.

**Why It Matters:** Professors evaluate tools on speed-to-first-course and whether students will actually use them. Only ~15% of instructors ever explore new LMS features — anything that adds steps effectively doesn't exist (see `docs/reference/user-signals.md`).

**The Solution:** Build the LMS AI-first: course generation in minutes, quizzes generated (with page-level source citations) from the professor's own uploaded lecture files, an AI tutor that cites the exact slide it learned from, live classrooms that produce automatic post-class insights, and mastery analytics that surface who's struggling on what — all in one system, with the human always approving what the AI proposes.

## ✨ Key Features

- **Athena** — one AI assistant, three surfaces: a professor console that drafts (assignments, announcements, rubrics…) as approve-able cards, a dock that fills the authoring screen you're looking at (assignments, quizzes, the course About page), and a student tutor grounded in course materials
- **Live Classroom** — realtime slide sync, polls, AI-generated live quizzes from the running transcript, Q&A, a projector view, and automatic post-class reports + student study packs
- **Assignment Studio** — professors author interactive artifacts (live notebooks, rich documents, AI-led verbal interviews), with rubrics and hybrid AI grading suggestions
- **Quiz system** — question bank, single-screen studio editor, server-side grading, proctoring, leaderboards, and a live IRT-based adaptive mode (CCAT)
- **Skills / Topic Mastery + Roadmap** — a per-course skill graph whose coverage and mastery are *derived from real activity*, never hand-ticked
- **Admin & multi-tenancy** — departments, programs, bulk roster import, TA/grader approval flows, and a super-admin tier with real cost reconciliation

## 🛠 Technology Stack

- **Framework:** Next.js 16 App Router (server components + server actions), TypeScript strict, deployed standalone in Docker
- **Backend:** Supabase — Postgres (~137 tables, RLS everywhere), Auth (invite-only), Storage (private buckets + signed URLs), Realtime (broadcast channels)
- **AI:** Google Gemini via the Vercel AI SDK (per-feature model constants); ElevenLabs for speech; Pinecone for material vectors (namespace-per-tenant)
- **UI:** Tailwind CSS v4 + shadcn/ui (new-york, neutral) + TipTap/Novel editors + Recharts
- **Testing:** Vitest (~3.6k tests) + Playwright e2e + markdown visual walkthroughs
- **Infra:** Google Cloud Run (us-central1) + Cloud Scheduler sweeps + one Gotenberg microservice; email via Resend

## 🚀 Quick Start

```bash
git clone <repo-url> && cd Scholera-prod
npm install                            # npm only — never yarn
cp .env.example .env.local             # point at the local stack
./scripts/dev-setup/setup-local.sh     # local Supabase + prod schema + dummy data
npm run dev                            # → http://localhost:3000
```

Log in with the seeded accounts the script prints (`professor@scholera.dev`, `student1@scholera.dev`, …).

👉 **Full setup, troubleshooting, and env-var reference: [2-quick-start.md](./2-quick-start.md)**

## 📍 Where to Start Exploring

### The 3 Most Important Files

1. **`src/middleware.ts`** — the *only* place auth redirects happen; understanding it explains the whole routing security model
2. **`src/lib/supabase/queries.ts`** — the centralized read layer (27 query groups, dependency-injected client, never throws); every page's data comes through here
3. **Any feature's `actions.ts`** (e.g. `src/app/(dashboard)/professor/courses/[sectionId]/announcements/actions.ts`) — the canonical mutation sequence every write follows

### Key Directories

- 📁 **`src/app/`** — routes: `(auth)`, `(dashboard)` (admin/professor/student/staff/super-admin), `(projector)`, `api/`
- 📁 **`src/lib/`** — 38 domain folders; the logic lives here, not in components
- 📁 **`src/components/`** — UI by role: `ui/` primitives → `shared/` → `professor/` (315 files) / `student/` (152)
- 📁 **`supabase/migrations/`** — 236 migrations that *are* the schema (replayable locally)

### Start Here If You Want To…

- **Understand the architecture** → [5-architecture.md](./5-architecture.md)
- **Add a feature to a course** → `src/lib/course-features.ts` (the registry) + an existing tab as a template
- **Fix a bug in a mutation** → the feature's `actions.ts` + its `src/__tests__/actions-*.test.ts`
- **Understand the data flow** → trace `page.tsx` → `queries.ts` → render, then `actions.ts` → gates → DB

## 💡 Key Concepts to Understand First

- **Institution = tenant**: every scoped row carries `institution_id`; leaking across tenants is the cardinal sin
- **Course ≠ section**: a *section* is one professor × one semester — almost everything hangs off the section
- **Authorization lives in code**: mutations use an RLS-bypassing admin client *after* explicit gates; RLS is the backstop
- **Extraction feeds everything**: uploaded lecture files are parsed once into structured content that powers quizzes, the tutor, citations, and mastery
- **AI proposes, humans commit**: Athena's draft tools can't mutate; the professor's approval calls a normally-authorized action

📚 **Full glossary in [3-concepts.md](./3-concepts.md)**

## 🎪 Try It Out

Once running locally:

1. **As the professor** (`professor@scholera.dev`): open a seeded course → **Quizzes** → create a quiz in the Studio → publish it
   - Expected: it appears instantly for students of that section
2. **As a student** (`student1@scholera.dev`, incognito window): take the quiz
   - Expected: server-graded results with a score breakdown; the attempt lands in `quiz_attempts` (check Supabase Studio at http://127.0.0.1:54323)
3. **Make a small change**: edit the hero text in `src/app/page.tsx`, watch it hot-reload, then revert

## 📚 Next Steps

- **New to the codebase?** → [2-quick-start.md](./2-quick-start.md)
- **Want the structure?** → [4-visual-tree.md](./4-visual-tree.md)
- **Ready to contribute?** → [7-development.md](./7-development.md)
- **Need the full picture?** → [5-architecture.md](./5-architecture.md)
