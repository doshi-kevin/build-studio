# 💡 Concepts Guide

> The domain vocabulary and core patterns you need before the code makes sense. Skim once, then use as a glossary.

## 🏛️ Tenancy & People

**Institution** — the tenant. Every tenant-scoped row carries `institution_id`; RLS policies, code gates, and even DB guard triggers enforce that data never crosses institutions. **Scholera Dev** (`00000000-…-0002`) is the seeded sandbox institution used for all testing — never touch other institutions' data.

**Roles** (on `profiles.role`):

| Role | Who | Lands on |
|---|---|---|
| `student` | Enrolled learners (the default for new users) | `/student/*` |
| `professor` | Teaches sections | `/professor/*` |
| `course_assistant` | TAs and graders — **the URL segment is `/staff` but the role value is `course_assistant`**; the two strings are unrelated | The *professor* UI tree, reused with per-role write gating |
| `institution_admin` | The buyer's admins — manage departments, courses, people, rosters | `/admin/*` |
| `super_admin` | Scholera platform staff — cross-tenant: institutions, team, cost analysis | `/super-admin/*` |

**Section staff** — a professor can't add a TA directly; they file a `section_staff_request` that an institution admin approves. Active staff rows have an `ends_at`; expiry is lazy (filtered at query time, no cron).

**Invite-only** — public `/signup` is disabled at the middleware. Users exist because an admin provisioned them (temp password or magic link). The invite lifecycle is `pending → accepted → active` (students flip to `active` on their first `/student/*` visit). **CWID** — students can log in with an 8-digit campus ID instead of email; resolution is deliberately server-side and password-gated (enumeration protection).

## 🎓 Academic Structure

**Course vs Course Section** — the split to internalize. A *course* is the catalog entity (code, title, credits, department). A *section* is one professor teaching it one semester. Almost everything hangs off the **section**: enrollments, modules, quizzes, assignments, staff, settings, Athena, vectors.

**Module / Module item** — the content tree of a section. Items are typed (lecture, video, reference, assignment link, …) and carry a `content` jsonb that includes the **extraction** (below). A module's `unlock_date` means "listed but not open yet" — published ≠ open.

**Extraction** — when a professor uploads a lecture file, a background worker parses it (deterministic pdfjs/fflate parsers first, vision model only as a gated fallback) into `module_items.content.extraction`: text pages, images, formulas, tables, and **concepts**. This stored extraction is the substrate for quiz generation, AI-tutor retrieval, citations, node checks, primers, and embeddings — one extraction feeds everything.

**Citation** — AI answers and generated quiz questions cite their source as `[Title, page N]` with a deep link back into the module (`?item=…&page=…`) and a rendered page preview. Trust badges derive from how the citation was attributed.

## 🤖 Athena (the AI assistant)

**Athena** is the product's single AI identity, but architecturally **three separate surfaces**:

1. **Professor console** (`/professor/courses/[sectionId]/assistant`, `/api/professor-assistant`) — full-page chat with persisted conversations. Its tools return **draft cards** (assignment, announcement, rubric, module drafts…) that the professor edits and approves; the tools deliberately have no `execute` — approval calls a normally-authorized server action.
2. **Authoring dock** (`/api/assignment-assistant`) — a docked panel mounted at the assignments and quizzes layouts, and embedded on the course **About page** builder. Context-aware **by registration** (`useAthenaSurface`, with an authoring `kind` per screen — `notebook`, `document`, `verbal`, `quiz`, `about`), its FILL tools write directly into the on-screen editor state with undo; nothing persists until the professor saves. On the About page it can also derive the weekly schedule from real modules and due dates, drift-check the page against the live course (report first, fix on confirmation), and import an existing syllabus PDF/docx — but a fill is refused until the professor enters edit mode, and the model can never touch storage-backed asset fields (`athena-about-adapter.ts`).
3. **Student tutor** (`/api/chat`, the `AthenaShell` dock) — three poses (closed pill · docked · fullscreen), read-only tools, grounded in the course's extracted materials via Pinecone. Tool inputs are structurally bounded (no identifiers allowed) so prompt-reachable IDOR is impossible by construction. It refuses to help while the student sits a graded quiz (**active-attempt lock**).

**Modes** — `standard` vs `frontier` (frontier adds design tools; it's a mode axis, orthogonal to the surface). **Artifacts** — interactive study elements Athena leaves on the student's roadmap (registry: `lib/athena/artifact-kinds.ts`). **Rate limits** — daily caps per (institution, user, scope, model) with model failover; every call lands in the cost ledger.

## 📝 Quizzes

**Question bank** → questions live per-section and are *assigned* to quizzes (`quiz_question_assignments`). **Quiz Studio** — the single-screen editor (rail · canvas · settings drawer · student preview); AI generation streams questions in batches with source citations. **Attempt flow** — server-side grading (`lib/quiz/scoring.ts` — the highest-coverage module in the repo), autosave, negative marking, bonus, formula sheets, leaderboard.

**Adaptive (CCAT)** — the live adaptive engine is **IRT-based** (2PL/3PL, ability θ estimated per response; free-text graded by Gemini against rubric nodes feeding a soft-label likelihood). One question served at a time, chosen by the engine. ⚠️ An older Elo-based engine was wired out for IP reasons (`archive/ADAPTIVE-WIREOUT.md`) — CCAT is live and intentional; don't confuse the two.

**Proctoring** — two client-side flavors: event capture (tab switches, paste, fullscreen exits) and video (face-api + COCO-SSD phone detection, snapshots only on violation). Evidence is **advisory** — it never changes a grade automatically.

## 📋 Assignments

Three authored kinds, one **Studio** workflow (Build → Add files & rubrics → Publish, with "View as student" throughout):

- **Notebook** — a live `.ipynb`-round-trippable notebook (nothing executes server-side; the lossless round-trip is the correctness proof)
- **Document** — a Notion/Docs-style page with slash commands and rich nodes (charts, equations, maps, solvers)
- **Verbal** — an AI-led spoken interview (topic, voice, follow-up depth); grading stays with the professor

**Rubric** — Gradescope-style; can be AI-drafted from studio cells/answer keys, professor approves. **AI grading** runs in modes (similarity-only / LLM-only / hybrid — similarity certifies at ≥0.80, the LLM reviews rejections, confident rejections of high-value criteria route to a human). Suggestions are always *suggestions*; `assignment_ai_grade_suggestions` never becomes a grade without the professor.

**Assessment mode** — a timed, proctored assignment in three phases (lobby → work → upload); the phase is always recomputed server-side, and the brief is only sent during the work phase so a reload can't leak it.

## 🎥 Live Classroom

A professor drives a slide deck; students follow in sync, answer polls/quizzes, ask questions, react, take notes.

- **Room** (`lc_rooms`) — one live session per section; **deck** — PDF (PPTX converts via the Gotenberg microservice)
- **Broadcast architecture** — one realtime channel per room, two topics: **authoritative** (DB triggers emit sequenced, persisted envelopes — slide changes, interactions) and **ephemeral** (client-emitted strokes/reactions, never persisted). Late joiners converge via snapshot + seq-anchored replay
- **Projector view** (`/projector/...`) — a chrome-less second-display window; deliberately renders no interaction content and only the answer-stripped snapshot
- **Interactions** — polls and AI-generated live quizzes (from the running transcript); answers stripped server-side before broadcast
- **Transcription** — browser streams audio directly to ElevenLabs Scribe (raw audio never touches our server); the transcript feeds live-quiz generation and post-class insights
- **Post-class** — **Session report** (professor: attendance, participation, AI narrative) and **Class Insights** (student: PII-free study pack — summary, how-you-did, flashcards, practice quiz). **Catch Me Up** — mid-class AI summary for late joiners
- **Pre-Class Primer** — a short AI-generated audio "advance organizer" per lecture, professor-toggled, student-consumed

## 🗺️ Roadmap & Skills

**Roadmap** — a React Flow canvas derived from modules and their items. **Coverage/status is derived from real activity, never hand-ticked.** Node checks are small AI-generated comprehension questions per material (pool generated lazily when the first student opens the node; a student never receives the answer index). **Triage** — the pure engine that turns raw signals into the few annotations a professor should look at.

**Skills / Topic Mastery** — a per-section, two-level skill hierarchy. The **reconciler** merges concepts from every source (upload extraction, question tags, live-quiz titles) into one canonical pool; mastery updates incrementally on grade finalization and is rebuilt idempotently by a nightly **recompute** sweep. Tiers: **Weak** <60 · **Shaky** 60–79 · **Strong** 80–100. (Renamed from "topics" to "skills" mid-2026 — you'll see both words in older migrations.)

**Outcomes (ABET)** — a cached map/reduce background pipeline aligning course evidence to accreditation indicators.

## 🔔 Events, Notifications & To-dos

**`events` table** — the universal audit/analytics spine; every mutation `logEvent()`s.

**Shared event layer** — `emitEvent()` writes per-recipient **`feed_items`** rows consumed by *two* surfaces: the notification bell and the dashboard to-do list (`is_actionable`/`is_done`). Emit once, consume twice. New types go in `lib/events/types.ts`.

**Scholera Pulse** — the scheduled notification sweeps (deferred publishes, daily digest, re-engagement, reminders) behind `/api/notifications/cron`. ⚠️ **Fails closed in production** until Cloud Scheduler OIDC lands; local stand-ins live in `scripts/dev-setup/pulse-*`.

## 🎛️ Feature Toggles

`course_sections.settings` carries **three independent keys**:

- `enabledFeatures` — what **students** can reach (enforced by `verifyFeatureEnabled`, which 404s direct navigation)
- `sidebarHidden` + `sidebarOrder` — the **professor's own** nav arrangement

They are deliberately decoupled: the professor sidebar lists every feature by default with draft/published/hidden states — **never re-filter it on `enabledFeatures`**, and never hide student-enabled features in code.

## 🔌 AI Kill Switch

Above the per-course toggles sits a tenant-level **AI kill switch** — three policy layers, a feature is OFF if *any* layer disables it: **global** (`platform_settings.settings.ai`, super admin, every institution incl. future ones), **platform** (`institutions.settings.ai.platform`, super admin, one institution), **institution** (`institutions.settings.ai.institution`, the institution admin at `/admin/settings`; super-admin surfaces at `/super-admin/ai-controls` + each institution's detail page). Higher layers lock lower switches without erasing them. Writes go only through the `set_institution_ai_policy` RPC (role re-checked in SQL, version-guarded); reads go through `checkAiFeature` (`src/lib/ai/kill-switch.ts`), which **fails closed** on errors. The feature vocabulary (9 groups) lives in `src/lib/ai/ai-features.ts` — a new AI call site fails lint + the coverage test until it's gated and allowlisted (`ai-call-site-coverage.test.ts`).

## 🧩 Other Features You'll Meet

- **Course About page** — a block-based page builder (pinned hero, syllabus, FAQ, contact, …) at the professor's `…/about` route; content autosaves into `course_sections.settings.about` and renders read-only on the student course home. Athena is embedded here as an authoring-dock surface (see above)
- **Intel** — crowd-sourced course intelligence (reviews, Q&A, tips, resources) written by alumni, readable by enrolled students
- **Challenges / badges / certificates** — professor-defined challenge board; milestone certificates get public share pages (`/c/[publicId]`)
- **Projects** — team workspaces: phases, multi-canvas docs, team chat (students-only — professors deliberately can't see team channels), meetings
- **Discussions vs DMs** — course-scoped channels vs global 1:1 messages; both reuse the same chat engine (`components/shared/chat/`)
- **Knowledge Warehouse** — the professor file library; **withdrawn** (its persistence was a localStorage mock) and closed at the door pending a real backend
- **DeadEnd** — the shared denial surface: `missing` (compass) vs `no-access` (lock). The variant is a security decision — anything keyed by a resource ID renders `missing`, because "you can't access X" confirms X exists
- **Cost Analysis** — the super-admin page reconciling metered AI/external spend against actual vendor bills, gap shown not hidden
- **Studio** (in progress on `feature/studio`): a professor-side course tab at `…/courses/[sectionId]/studio`, visible to the professor and to course assistants and never to students. It will become the place a professor builds a course tool from a plain-language prompt, drawing on that section's own materials and skills. Course assistants see it because `courseAssistantCanSee` (in `course-features.ts`) lets allowlisted professor tools through without a publish step. Plugin storage is five server-only tables (`studio_plugin_projects`, `_versions`, `_installations`, `_approvals`, `_records`): a reusable project publishes immutable versions, each section installs a version and must approve it before it runs there, and plugin data belongs to the installation. The builder (Step 7B) is an agent harness: the professor describes a tool, a background job drives a model through nine fixed tools to edit a private working copy, checks it, and saves an immutable draft snapshot the professor can preview; saving it as a version is a separate professor click. Rules: `docs/reference/studio-plugin-rules.md`; the builder: `docs/reference/studio-agent-harness.md`

## 🔁 Core Code Patterns (the shorthand reviewers use)

| Phrase | Meaning |
|---|---|
| "the action sequence" | `getAuthUser → verify → createAdminClient → Zod → DB op → logEvent → revalidatePath → {success}\|{error}` |
| "queries take the client" | Every `queries.ts` function takes `SupabaseClient` first, catches internally, returns a safe fallback |
| "resolveJoin it" | Supabase embedded joins return object *or* array — normalize with `resolveJoin()` |
| "claim-then-act" | Sweeps/workers atomically claim a row before acting, so re-runs and concurrent instances can't double-send |
| "it's a registry" | Extend by adding an entry (features, jobs, events, templates, artifact kinds) — not by editing consumers |
| "purity split" | Pure logic module + thin I/O shell; test the pure part |
| "fire-and-forget" | Telemetry (logEvent/emitEvent/cost recording) never blocks or breaks the feature |
| "server-only vs client-safe" | Files are explicitly split so provider SDKs and the admin client can never enter the browser bundle |

## 📚 Next Steps

- How these concepts wire together → [5-architecture.md](./5-architecture.md)
- The files behind them → [6-file-insights.md](./6-file-insights.md)
