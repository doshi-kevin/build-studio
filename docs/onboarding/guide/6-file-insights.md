# 📚 File Insights Guide

> Deep dive into the most architecturally significant files in this codebase — what each one is for, its key exports, how it connects to everything else, and the pitfalls around it.

> **Repository scale**: ~2,200 tracked files (1,765 under `src/`). This guide covers the files that define the system's structure — the entry points, the data/auth layer, the AI plumbing, and one representative per major domain. The complete inventory is in [4-visual-tree.md](./4-visual-tree.md); domain-by-domain breadth is in [5-architecture.md](./5-architecture.md).

## 🎯 Quick Navigation

| Category | Files |
|---|---|
| [🚀 Entry points](#-entry-points) | `middleware.ts`, `app/layout.tsx`, `next.config.ts` |
| [💾 Data layer](#-data-layer-srclibsupabase) | `server.ts`, `client.ts`, `admin.ts`, `queries.ts`, `types.ts`, `event-logger.ts`, `signed-urls.ts`, helpers |
| [🔐 Authorization](#-authorization-srclibauth) | `tenant-context.ts`, `admin-context.ts`, `section-access.ts`, `assert-tenant-owns.ts` |
| [🤖 AI layer](#-ai-layer) | `ai/llm-client.ts`, `ai/config.ts`, `ai/prompts.ts`, `pinecone/` |
| [🎯 Core domains](#-core-domain-files) | quiz scoring/IRT, live-classroom broadcast, jobs, extraction, skills, events |
| [⚙️ Configuration](#-configuration) | `course-features.ts`, `validations/features.ts`, `package.json`, `Dockerfile` |
| [🎨 Landmark components](#-landmark-components) | `QuizStudio`, `AssistantConsole`, `AthenaShell`, `ClassroomDashboard` |

---

## 🚀 Entry Points

### 📄 `src/middleware.ts` (147 lines)

**Purpose**: The **sole** handler for authentication redirects in the entire app — no page or layout ever redirects for auth (this prevents redirect loops).

**What it does** (runs on every request except static assets):
- **Rule 0**: `/signup` is disabled — Scholera is invite-only; visitors bounce to `/login`
- **Rule 1**: unauthenticated users hitting `/dashboard`, `/admin`, `/super-admin`, `/professor`, `/student`, `/staff`, or `/projector` → `/login`
- **Rule 2**: authenticated users on `/login`/`/signup`/`/forgot-password` → `/dashboard` (except when invite tokens or a PKCE `?code=` are present)

**Important notes**:
- It builds its own Supabase client (not `lib/supabase/server.ts`) because middleware has a different cookie API
- It uses `getUser()` (server-validated) rather than `getSession()` (local JWT decode) — deliberate security choice
- **Middleware only authenticates. Authorization (role checks) happens in layouts**, which render a `DeadEnd` instead of redirecting

### 📄 `src/app/layout.tsx` + route-group layouts

Root layout wires fonts (Geist Sans/Mono + Instrument Serif) and `globals.css`. The interesting layouts are the guards:

| Layout | Guard |
|---|---|
| `(dashboard)/layout.tsx` | Fetches user + profile, renders header + role-aware sidebar. Never redirects; renders gracefully with a null profile |
| `(dashboard)/admin/layout.tsx` | `role === 'institution_admin'` or renders `DeadEnd` |
| `(dashboard)/super-admin/layout.tsx` | `role === 'super_admin'` |
| `(dashboard)/staff/layout.tsx` | `role === 'course_assistant'` (URL says `/staff`; the role value is `course_assistant` — the strings are unrelated) |
| `(dashboard)/professor/layout.tsx` | Admits `professor`, `institution_admin`, **and** `course_assistant` — TAs reuse the professor UI tree; per-section rejection happens in `professor/courses/[sectionId]/layout.tsx` via `verifySectionAccess` |
| `(dashboard)/student/courses/[sectionId]/layout.tsx` | Verifies **enrollment**, renders read-only sidebar of student-enabled features |
| `(projector)/layout.tsx` | Chrome-less; mounts `RealtimeAuthMount` so the private realtime channel authorizes |

### 📄 `next.config.ts` (74 lines)

Every entry has a reason documented inline — read the comments before touching it:
- `output: 'standalone'` — required by the Docker/Cloud Run deploy
- `bodySizeLimit: '260mb'` — assignment submissions POST files through a server action; must cover 25 MB × 10 files
- `serverExternalPackages` — `pdfjs-dist`, `sharp`, `@napi-rs/canvas` etc. must not be bundled (native binaries / worker resolution breaks)
- Anti-clickjacking headers (`X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`) — app-wide; the LTI work must *widen* these per-route, never delete them

---

## 💾 Data Layer (`src/lib/supabase/`)

### 📄 `server.ts` (50 lines) — the server client

```ts
const supabase = await createClient()   // MUST await — cookies() is async in Next 16
```
Cookie-bound client for server components, server actions, and route handlers. Runs **with RLS** as the signed-in user. Forgetting `await` causes cryptic runtime errors — this is the #1 newcomer mistake.

### 📄 `client.ts` — the browser client

Singleton per tab. **Load-bearing**: `realtime.setAuth()` and channel subscribes must land on the *same instance*, or private-channel RLS silently rejects everything.

### 📄 `admin.ts` (48 lines) — the service-role client

`createAdminClient()` **bypasses all RLS**. Only use it *after* server-side authorization (see the auth helpers below). Never import into anything reachable from a `'use client'` tree.

**The mental model for all three:**

```
Who is asking?                    → Which client?
Browser code                      → client.ts   (RLS enforced)
Server code, acting AS the user   → server.ts   (RLS enforced)
Server code, AFTER verifying authz → admin.ts   (RLS bypassed — YOU are the gate)
```

### 📄 `queries.ts` (6,074 lines) — the centralized query layer

All DB read functions live here, organized as **27 exported query-group objects** (`profileQueries`, `courseQueries`, `enrollmentQueries`, `liveClassroomQueries`, `skillQueries`, …).

**The universal contract** — every function:
1. takes `supabase: SupabaseClient` as its **first parameter** (dependency injection: callers choose user-client vs admin-client)
2. catches errors internally and logs via `logger.error('namespace.fn', …)`
3. returns a safe fallback (`null`, `[]`, `0`) — **never throws**

**Usage**:
```ts
const supabase = await createClient()
const profile = await profileQueries.getProfileById(supabase, user.id)
```

### 📄 `types.ts` (9,657 lines) — generated schema types

Auto-generated from the database. **Never edit by hand**; regenerate with `npx supabase gen types typescript`. Exports the `Database` interface plus named row types.

### 📄 `event-logger.ts` (75 lines)

`logEvent({ userId, eventType, sectionId?, metadata? })` — fire-and-forget audit writes to the `events` table via the admin client. **Every mutating server action calls this** — it feeds analytics and audit logs. Never blocks or throws.

### 📄 `signed-urls.ts` — private-bucket access

Render-time signing for private storage buckets, with per-surface TTLs (course materials 1h, live classroom 6h, project chat 15m, announcements 12h). Uses the admin client, so **authorization must happen upstream** — signing is capability-granting.

### 📄 The small-but-critical helpers

| File | Why it exists |
|---|---|
| `resolve-join.ts` | Supabase embedded joins return object *or* single-element array depending on context. `resolveJoin(val)` normalizes. Use it on every join |
| `paged-read.ts` | PostgREST **silently caps unbounded selects at 1000 rows** — which makes whole-set aggregates (class average, item statistics) *wrong*, not just incomplete. `readAllPages()` pages through everything |
| `cookie-options.ts` | Single source of truth for auth-cookie attributes; adds `secure` in production (the library default omits it) |
| `realtime-auth.ts` | Pushes the JWT into the realtime client; mounted once in the dashboard layout. Without it, private channels fail after the first token rotation (~1h) |
| `storage.ts` / `chat-storage.ts` | Bucket constants + upload helpers. Chat paths are `{teamId}/{channelId}/…` — **load-bearing**, RLS checks the team prefix |

---

## 🔐 Authorization (`src/lib/auth/`)

Because mutations run on the RLS-bypassing admin client, **these helpers are the real access control** — RLS is the backstop, not the gate.

| File | Contract | Use it in |
|---|---|---|
| `tenant-context.ts` | `getCurrentInstitutionId()` — reads `institution_id` from the JWT's `app_metadata` (fast path, synced by a DB trigger), falls back to a profiles lookup | Anywhere calling a tenant-scoped query |
| `admin-context.ts` | Verifies signed-in + `institution_admin` role + institution not suspended → `{ userId, institutionId }` or `{ error }` | Every institution-admin action |
| `super-admin-context.ts` | Same shape for `super_admin` | `/super-admin/*` actions |
| `section-access.ts` | `verifySectionAccess(sectionId, userId)` → is the caller the section's professor or an active TA/grader, and which? Lets staff reuse the professor UI tree with per-role write gating. **Three predicates decide what each role may do, and picking one is a decision** — `canWriteAsProfessor` (destructive/irreversible), `canWriteAsStaff` (authoring: content, announcements), `canGrade` (score writes, includes graders). The file's own comment is the spec; read it before adding a call site | Every professor/staff course-tree action |
| `assert-tenant-owns.ts` | Verifies a caller-supplied entity ID belongs to the caller's institution **before** mutating. Without it, a tenant-A admin holding a tenant-B UUID could mutate tenant B through the admin client | Every admin action taking an entity ID |

**The canonical mutating-action sequence** (see any `actions.ts`, e.g. announcements):

```
getAuthUser() → verifySectionAccess / verifyEnrollment / adminContext
             → createAdminClient()
             → DB op (with institution_id on every tenant-scoped write)
             → logEvent()
             → revalidatePath()
             → return { success: true } | { error: '…' }   // never throw
```

---

## 🤖 AI Layer

### 📄 `src/lib/ai/llm-client.ts` (2,179 lines)

The shared Gemini call layer — all feature entry points live here: `generateQuizQuestions`, `extractTopicsFromContent`, `generateLiveQuizFromTranscription`, `summarizeLectureContent`, `generateFlashcards`, `generatePrimerScript`, `rewriteAnnouncement`, and more. Every call routes through an internal `track()` that writes the AI cost ledger (`ai_usage_events`).

**Provider**: Google Gemini only, via the Vercel AI SDK (`@ai-sdk/google`).

### 📄 `src/lib/ai/config.ts` — model registry

All model IDs are named per-feature constants so a swap is a one-line change: `gemini-3-flash-preview` (the workhorse), `gemini-3.1-pro-preview` (Athena pro tier), `gemini-3.1-flash-lite-preview` (node checks — the cheapest call in the codebase), `gemini-embedding-001` @ 1536 dims (skills embedding; note the **materials vector store pins a different model** — see Pinecone below).

### 📄 `src/lib/ai/prompts.ts` (741 lines)

Central registry of every system prompt and prompt builder. Related guardrails worth knowing: `prompt-fence.ts` (fences untrusted display strings — names, extracted topics — before they enter a prompt) and `streaming-blocks.ts` (balances partial `$$`/code fences during streaming).

### 📁 `src/lib/pinecone/` (10 files) — the vector store wrapper

Pinecone has **no RLS**, so this wrapper *is* the tenant boundary:
- `namespace.ts` exports exactly one function, `namespaceFor(institutionId, sectionId)` — **no public API accepts a raw namespace string**; the derivation is the security wall
- `config.ts` pins `gemini-embedding-2` @ 3072 dims, chunker version, metadata schema version — changing any of these means a blue/green re-index into a **new** index, never in-place
- `embed.ts` is the only place pages/queries get embedded (mixed-model vectors corrupt retrieval silently); it embeds multimodal [text + page image]
- `data.ts` / `search.ts` are the data plane and read primitive — callers must have verified section access *first*
- `ids.ts` — deterministic id grammar `{module_item_id}#p{zero-padded page}` (padding matters: `#p1` would prefix-match `#p10`)

Rules live in `.claude/rules/vector-db.md` — read it before touching any vector code.

---

## 🎯 Core Domain Files

### 📄 `src/lib/quiz/scoring.ts` + `src/lib/quiz/irt/`

`scoring.ts` is the **pure** grading engine (negative marking, bonus, extra credit) — 95% line-coverage target, test it against `src/__tests__/scoring.test.ts`. The `irt/` folder holds the CCAT adaptive engine: `estimator.ts` (pure 2PL/3PL IRT with soft-label likelihood) and `grader.ts` (server-only Gemini rubric-node grading feeding the likelihood). The older Elo-style `adaptive-engine.ts` still exists; CCAT is the live engine.

### 📄 `src/lib/live-classroom/broadcast/use-room-channel.ts` (322 lines)

The centerpiece of the realtime classroom. One resilient Supabase Broadcast channel per room, two topics: **authoritative** (DB-trigger-emitted, sequenced, persisted to `lc_events`) and **ephemeral** (client-emitted strokes/reactions, never persisted). Handles snapshot-on-join + seq-anchored replay, dedupe, spoof rejection, exponential backoff, and re-replay on tab-visibility. All other `use-*` hooks (`use-slide-sync`, `use-interactions`, `use-questions`, `use-drawings`, `use-presence`, `use-reactions`) compose on top of this single channel via a per-channel event bus.

**Mental model**: durable state loads once via `getRoomSnapshot(roomId)`; thereafter broadcast envelopes patch it. A refresh always rehydrates from the server, never from replayed events alone.

### 📄 `src/lib/jobs/` — the background-jobs foundation

A feature plugs in a `BackgroundPipeline { type, run(params, ctx) }` (registered in `registry.ts`); the foundation owns the durable `background_jobs` queue, atomic claim, the route-kicked worker (`/api/jobs-worker/kick`, drained by app calls + a GitHub Actions sweep), progress, and completion notifications. Enqueue is idempotent (partial unique index: one pending job per subject). Registered pipelines: `outcome_alignment`, `render_scheduled_deck`, `embed_material`, `node_check_pool`, `regenerate_student_insights`.

### 📄 `src/lib/extraction/worker.ts` (893 lines)

The document-extraction pipeline: uploaded lecture file → text pages, images, formulas, tables, concepts stored in `module_items.content.extraction`. Claim-based queue (`FOR UPDATE SKIP LOCKED` RPC) with supersession (re-upload cancels pending jobs). **The stored extraction is the substrate for nearly everything downstream** — quiz generation, citations, node checks, embeddings. The deterministic parsers live in `src/lib/document-parser/` (native pdfjs/fflate extraction first, vision model only as a gated fallback).

### 📄 `src/lib/skills/reconcile.ts` (970 lines) + `recompute.ts`

Topic/Skill Mastery. `reconcile.ts` merges concepts from every feeder (upload-time AI extraction, question tags, live-quiz titles) into one canonical deduplicated `skills` pool per section. Two update paths: an incremental `grade-hook.ts` on grade finalization, and the idempotent `recompute.ts` that rebuilds `skill_mastery` chronologically (safe to re-run; a nightly sweep backstops it). Tiers: Weak &lt;60 · Shaky 60–79 · Strong 80–100.

### 📄 `src/lib/events/emit.ts` — the shared event layer

**Emit once, consume twice**: `emitEvent()` writes per-recipient `feed_items` rows that power both the notification bell and dashboard to-dos. Idempotent upsert on (recipient, type, entity). New event types go in `events/types.ts` — never ad-hoc strings. Design doc: `docs/designs/notifications-calendar/shared-event-layer.md`.

---

## ⚙️ Configuration

### 📄 `src/lib/course-features.ts` — the feature registry

The toggleable course features (categorized `basic` / `additional` / `professor`). Adding a feature = one registry entry + one route page. Interacts with three **independent** keys on `course_sections.settings`:
- `enabledFeatures` — what **students** can see (enforced by `verifyFeatureEnabled`)
- `sidebarHidden` + `sidebarOrder` — the **professor's own** nav
These are deliberately decoupled — never re-filter the professor sidebar on `enabledFeatures`.

### 📄 `src/lib/validations/features.ts`

`verifyFeatureEnabled` — throws `notFound()` when a student navigates directly to a disabled feature URL. Called by most student course-tab pages.

### 📄 `src/lib/validations/` (51 files)

One Zod schema file per domain, used twice: client `react-hook-form` resolvers and server-action `safeParse` (defense in depth). Largest: `assignment.ts` (1,019 lines), `quiz.ts` (805, discriminated union on question type).

### 📄 `package.json` / `Dockerfile` / `vitest.config.ts`

npm-only (single `package-lock.json`; Docker builds with `npm ci`). Next.js 16 + React 19 + Tailwind 4 + Supabase JS v2 + Vercel AI SDK v6. Vitest runs jsdom against `src/__tests__/` with `setup.ts`.

---

## 🎨 Landmark Components

Full component map in [5-architecture.md](./5-architecture.md); these four are the biggest and most instructive:

| Component | Size | Why it matters |
|---|---|---|
| `src/components/professor/quizzes/wizard/QuizStudio.tsx` | 2,856 lines | The largest component in the repo — the single-screen quiz editor (rail · canvas · settings drawer · preview). AI is not a mode: Athena writes through the same state the professor's hands use |
| `src/components/professor/assistant/AssistantConsole.tsx` | 1,419 lines | Athena's full-page professor console — saved conversations, draft cards, persistence via `/api/professor-assistant` |
| `src/components/student/athena/AthenaShell.tsx` | 687 lines | The student AI dock — three snapping poses (closed · docked · fullscreen) |
| `src/components/live-classroom/… + professor/live-classroom/ClassroomDashboard.tsx` | 650 lines | The presenter control surface — thin component over the fat `lib/live-classroom/broadcast/` hook layer |

Security-notable components: `ui/dead-end.tsx` (the `missing` vs `no-access` variant choice is a tenancy-leak decision — anything keyed by a resource ID stays `missing`), `ProjectorView` (viewer-safe snapshot, quiz answers stripped server-side), `SubquestionCommentThread` (plain-text-only rendering across the student/staff boundary).

---

## 🗺 File Relationship Map

```
                         Browser
                            │
                    src/middleware.ts        (authN redirects only)
                            │
            ┌───────────────┼────────────────┐
            ▼               ▼                ▼
     page.tsx (RSC)    actions.ts        /api/* routes
     (reads, via       ('use server'     (streaming AI, workers,
      server.ts +       mutations)        webhooks, feeds)
      queries.ts)           │                │
            │        lib/auth/* gates ◄──────┤
            │               │                │
            │        admin.ts (RLS bypass)   │
            │               │                │
            ▼               ▼                ▼
        Supabase Postgres (RLS) ── events / feed_items / ai_usage_events
            │
            ├── Storage (private buckets, signed-urls.ts)
            ├── Realtime (broadcast channels, realtime-auth.ts)
            └── projections: Pinecone vectors (lib/pinecone/),
                extraction jsonb, skill_mastery — all rebuildable
```

## 📈 Complexity Analysis

**Highest-complexity files (study before modifying):**
1. `src/lib/supabase/queries.ts` — 6,074 lines, 27 query groups; the blast radius of the DI + never-throw contract
2. `src/components/professor/quizzes/wizard/QuizStudio.tsx` — 2,856 lines of interlocked editor state
3. `src/lib/ai/llm-client.ts` — 2,179 lines; every AI feature's entry point + cost tracking
4. `src/lib/skills/reconcile.ts` — 970 lines of multi-source dedup logic
5. `src/lib/extraction/worker.ts` — 893 lines; queue semantics + supersession

**Good starting points (simple and idiomatic):**
1. `src/lib/supabase/resolve-join.ts` — tiny, and teaches you a real Supabase quirk
2. `src/app/(dashboard)/professor/courses/[sectionId]/announcements/actions.ts` — a textbook example of the full server-action sequence
3. `src/lib/quiz/scoring.ts` — pure function + a thorough test file
4. `src/lib/course-features.ts` — the registry pattern used everywhere

## 🎓 Suggested Reading Order

1. **`src/middleware.ts`** — how requests get in
2. **`src/lib/supabase/server.ts` + `admin.ts` + `queries.ts`** (skim one query group) — how data gets read
3. **`src/lib/auth/section-access.ts`** + the announcements `actions.ts` — how mutations are authorized
4. **`src/lib/course-features.ts`** — how features are toggled per course
5. **One vertical slice**: professor quizzes page → `QuizStudio` → quiz actions → `lib/quiz/` — how a full feature hangs together
6. **`src/lib/events/emit.ts` + `lib/jobs/`** — how async/notification work flows

## ⚠️ Repo-Wide Pitfalls

- Forgetting `await createClient()` → cryptic runtime errors
- Using the admin client without an auth-helper gate → tenant data leak (the #1 review-blocking mistake)
- Trusting an unbounded select for an aggregate → silently wrong at &gt;1000 rows (use `readAllPages`)
- Editing `types.ts` by hand → clobbered on next generation
- Filtering the professor sidebar by `enabledFeatures` → hides features from the professor who owns them
- Hand-numbering a migration file → collides with parallel branches; always `npx supabase migration new`
