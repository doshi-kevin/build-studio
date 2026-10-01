# 🌳 Visual Tree — Complete Repository Map

> Every tracked file in the repository (2,204 files across ~349 directories), organized for navigation. Directory-purpose notes precede each section; expand any section for its complete file listing.

## 📏 Repository Scale

This is a **large repository** (~2,200 tracked files). This page shows **every file** — no truncation — using one collapsible section per top-level area. Start with the annotated landmarks map below to orient yourself, then expand the area you need.

**Where things live, in one breath:** app routes in `src/app/`, UI in `src/components/`, domain logic in `src/lib/`, unit tests in `src/__tests__/`, schema in `supabase/migrations/`, e2e in `e2e/`, deploy in `infra/`, team docs in `docs/`.

## 🔍 Icon Legend (landmarks map)

| Icon | Meaning |
|------|---------|
| ⚡ | Entry point / critical path |
| ⚙️ | Configuration |
| 🔐 | Security-critical |
| 🤖 | AI layer |
| 📁 | Major directory |
| ✓ | Tests |
| 📄 | Documentation |
| 🚀 | Build / deploy |

## 🗺️ Landmarks Map (the files that matter most)

```
Scholera-prod/
├── ⚡ src/middleware.ts                  # THE auth-redirect layer (only place redirects happen)
├── 📁 src/app/                           # Routes: (auth) / (dashboard) / (projector) / api
│   ├── ⚡ (dashboard)/layout.tsx         # App shell; role layouts guard below it
│   ├── 📁 (dashboard)/professor/courses/[sectionId]/   # The professor course workspace (20+ tabs)
│   ├── 📁 (dashboard)/student/courses/[sectionId]/     # The student course workspace
│   └── 🤖 api/chat + api/professor-assistant           # Streaming Athena endpoints
├── 📁 src/lib/
│   ├── 🔐 supabase/server.ts             # await createClient() — cookie-bound, RLS on
│   ├── 🔐 supabase/admin.ts              # createAdminClient() — RLS BYPASSED, gate upstream
│   ├── 📁 supabase/queries.ts            # 6,074 lines, 27 query groups, never throws
│   ├── 🔐 auth/                          # The real access control (section-access, tenant-context…)
│   ├── 🤖 ai/llm-client.ts               # Every Gemini call + cost tracking
│   ├── 🔐 pinecone/namespace.ts          # The vector-store tenant wall
│   └── 📁 live-classroom/broadcast/      # The realtime architecture
├── 📁 src/components/                    # ui/ → shared/ → professor|student|admin trees
├── ✓ src/__tests__/                      # 459 files, prefix-named
├── 📁 supabase/migrations/               # 236 migrations = the schema, replayable locally
├── ⚙️ next.config.ts                     # standalone output, body limits, anti-framing headers
├── ⚙️ package.json                       # npm only — never yarn
├── 🚀 infra/app/deploy-to-prod.sh        # Cloud Run deploy (main + clean tree enforced)
├── 🚀 Dockerfile                         # 3-stage Node 22 standalone build (+ LibreOffice)
├── 📄 CLAUDE.md                          # Coding rules — read before contributing
└── 📄 docs/onboarding/guide/             # This onboarding guide
```

## 📂 Root Files

```
CLAUDE.md            # AI-assistant coding rules (canonical conventions doc)
CONTEXT.md           # Project vision/status — ⚠️ stale (frozen Feb 2026); README is current
CONTRIBUTING.md      # Setup + contribution guide
Dockerfile           # 3-stage build → Cloud Run standalone image
PRODUCT.md           # Brand register, user archetypes, design principles
README.md            # Public front door: stack, features, getting started
components.json      # shadcn/ui config (new-york, neutral, Tailwind v4 CSS-first)
eslint.config.mjs    # Flat config (next core-web-vitals + TS)
next.config.ts       # standalone, 260MB body limits, serverExternalPackages, frame headers
package.json         # Scripts + deps (npm only)
postcss.config.mjs   # Tailwind v4 postcss plugin
tsconfig.json        # strict, @/* → ./src/*
vitest.config.ts     # jsdom, setup.ts, coverage thresholds on scoring + analytics-utils
.env.example         # Every env var with placeholders
.nvmrc               # Node 22
```

## 🌲 Complete Tree


### 📁 `src/app/` — 243 files

The Next.js App Router tree. Three route groups: `(auth)` (login/password flows), `(dashboard)` (everything behind login — admin, professor, student, staff, super-admin), and `(projector)` (the chrome-less second-display view for Live Classroom). `api/` holds streaming AI endpoints, background-worker kicks, webhooks, and the iCal feed. Convention: each feature page co-locates an `actions.ts` with its `'use server'` mutations; **auth redirects happen only in `src/middleware.ts`**, and role checks live in the group layouts. Some directories are actions-only (no page): `chat-reactions/`, `dms/`, `feedback/`, `professor/.../skills/`, `student/.../ai-tutor/`.

<details>
<summary>📂 Expand complete tree for <code>src/app/</code> (243 files)</summary>

```
app/
├── (auth)/
│   ├── forgot-password/
│   │   └── page.tsx
│   ├── login/
│   │   ├── actions.ts
│   │   └── page.tsx
│   ├── reset-password/
│   │   └── page.tsx
│   ├── CONTEXT.md
│   └── error.tsx
├── (dashboard)/
│   ├── admin/
│   │   ├── admins/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── courses/
│   │   │   ├── [courseId]/
│   │   │   │   └── page.tsx
│   │   │   └── actions.ts
│   │   ├── departments/
│   │   │   ├── [departmentId]/
│   │   │   │   ├── loading.tsx
│   │   │   │   ├── not-found.tsx
│   │   │   │   └── page.tsx
│   │   │   ├── actions.ts
│   │   │   ├── course-actions.ts
│   │   │   ├── loading.tsx
│   │   │   └── page.tsx
│   │   ├── extraction-jobs/
│   │   │   └── page.tsx
│   │   ├── feedback/
│   │   │   └── page.tsx
│   │   ├── professors/
│   │   │   ├── [professorId]/
│   │   │   │   └── page.tsx
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── programs/
│   │   │   ├── [programId]/
│   │   │   │   └── page.tsx
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── staff-requests/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── staff/
│   │   │   └── page.tsx
│   │   ├── students/
│   │   │   ├── [studentId]/
│   │   │   │   └── page.tsx
│   │   │   ├── actions.ts
│   │   │   ├── enrollment-actions.ts
│   │   │   ├── page.tsx
│   │   │   └── roster-actions.ts
│   │   ├── visual/
│   │   │   └── page.tsx
│   │   ├── layout.tsx
│   │   ├── loading.tsx
│   │   └── page.tsx
│   ├── chat-reactions/
│   │   └── actions.ts
│   ├── dashboard/
│   │   ├── actions.ts
│   │   ├── calendar-token-actions.ts
│   │   ├── loading.tsx
│   │   └── page.tsx
│   ├── dms/
│   │   └── actions.ts
│   ├── feedback/
│   │   └── actions.ts
│   ├── notifications/
│   │   └── page.tsx
│   ├── professor/
│   │   ├── calendar/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── camera-test/
│   │   │   └── page.tsx
│   │   ├── courses/
│   │   │   ├── [sectionId]/
│   │   │   │   ├── about/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── announcements/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── assignments/
│   │   │   │   │   ├── [assignmentId]/
│   │   │   │   │   │   ├── answer-key/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   ├── studio/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   ├── verbal/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── new/
│   │   │   │   │   │   ├── marketplace/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   ├── notebook/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   ├── stem/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   ├── verbal/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   ├── layout.tsx
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── assistant/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── challenges/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── discussions/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── enrollment/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── grades/
│   │   │   │   │   ├── student/
│   │   │   │   │   │   └── [studentId]/
│   │   │   │   │   │       └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── intel/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── live-classroom/
│   │   │   │   │   ├── [roomId]/
│   │   │   │   │   │   ├── report/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   ├── LiveClassroomStartButton.tsx
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── modules/
│   │   │   │   │   ├── [moduleId]/
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── projects/
│   │   │   │   │   ├── [projectId]/
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── quizzes/
│   │   │   │   │   ├── [quizId]/
│   │   │   │   │   │   ├── insights/
│   │   │   │   │   │   │   ├── loading.tsx
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   ├── proctoring/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   ├── submissions/
│   │   │   │   │   │   │   ├── [attemptId]/
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   ├── loading.tsx
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   ├── layout.tsx
│   │   │   │   │   ├── loading.tsx
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── roadmap/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   ├── error.tsx
│   │   │   │   │   ├── loading.tsx
│   │   │   │   │   ├── NodeCheckPanel.tsx
│   │   │   │   │   ├── NodeCheckReviewPanel.tsx
│   │   │   │   │   ├── page.tsx
│   │   │   │   │   ├── roadmap-annotations.tsx
│   │   │   │   │   ├── roadmap-class-lens.tsx
│   │   │   │   │   ├── roadmap-prototype.css
│   │   │   │   │   ├── roadmap-tracked-skills.tsx
│   │   │   │   │   └── RoadmapPrototype.tsx
│   │   │   │   ├── settings/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── skills/
│   │   │   │   │   └── actions.ts
│   │   │   │   ├── staff/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── actions.ts
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── not-found.tsx
│   │   │   │   └── page.tsx
│   │   │   └── page.tsx
│   │   ├── onboarding/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── preferences/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── students/
│   │   │   └── [studentId]/
│   │   │       └── page.tsx                # one student: other courses + busy/free grid
│   │   ├── warehouse/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── staff/
│   │   ├── courses/
│   │   │   ├── [sectionId]/
│   │   │   │   └── page.tsx
│   │   │   └── page.tsx
│   │   ├── layout.tsx
│   │   └── staff-README.md
│   ├── student/
│   │   ├── announcements/
│   │   │   └── page.tsx
│   │   ├── calendar/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── courses/
│   │   │   ├── [sectionId]/
│   │   │   │   ├── ai-tutor/
│   │   │   │   │   └── actions.ts
│   │   │   │   ├── announcements/
│   │   │   │   │   ├── [announcementId]/
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── assignments/
│   │   │   │   │   ├── [assignmentId]/
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   ├── assessment-actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── challenges/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── discussions/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── grades/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── intel/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── live-classroom/
│   │   │   │   │   ├── [roomId]/
│   │   │   │   │   │   ├── insights/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── modules/
│   │   │   │   │   ├── [moduleId]/
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── loading.tsx
│   │   │   │   │   ├── page.tsx
│   │   │   │   │   └── primer-actions.ts
│   │   │   │   ├── projects/
│   │   │   │   │   ├── [projectId]/
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   ├── chat-actions.ts
│   │   │   │   │   ├── docs-actions.ts
│   │   │   │   │   ├── loading.tsx
│   │   │   │   │   ├── meeting-actions.ts
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── quizzes/
│   │   │   │   │   ├── [quizId]/
│   │   │   │   │   │   ├── adaptive/
│   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   ├── attempt/
│   │   │   │   │   │   │   └── [attemptId]/
│   │   │   │   │   │   │       └── page.tsx
│   │   │   │   │   │   ├── results/
│   │   │   │   │   │   │   └── [attemptId]/
│   │   │   │   │   │   │       └── page.tsx
│   │   │   │   │   │   ├── loading.tsx
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   ├── loading.tsx
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── roadmap/
│   │   │   │   │   ├── actions.ts
│   │   │   │   │   ├── error.tsx
│   │   │   │   │   ├── loading.tsx
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── not-found.tsx
│   │   │   │   └── page.tsx
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── grades/
│   │   │   └── page.tsx
│   │   ├── office-hours/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── preferences/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   ├── profile/
│   │   │   ├── actions.ts
│   │   │   └── page.tsx
│   │   └── layout.tsx
│   ├── super-admin/
│   │   ├── cost-analysis/
│   │   │   ├── [institutionId]/
│   │   │   │   ├── loading.tsx
│   │   │   │   └── page.tsx
│   │   │   ├── data.ts
│   │   │   ├── loading.tsx
│   │   │   └── page.tsx
│   │   ├── institutions/
│   │   │   ├── [id]/
│   │   │   │   └── page.tsx
│   │   │   ├── new/
│   │   │   │   └── page.tsx
│   │   │   └── actions.ts
│   │   ├── team/
│   │   │   ├── actions.ts
│   │   │   ├── page.tsx
│   │   │   └── team-README.md
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── super-admin-README.md
│   ├── CONTEXT.md
│   ├── error.tsx
│   ├── layout.tsx
│   ├── not-found.tsx
│   └── notifications-actions.ts
├── (projector)/
│   ├── projector/
│   │   └── [sectionId]/
│   │       └── [roomId]/
│   │           └── page.tsx
│   ├── layout.tsx
│   └── not-found.tsx
├── api/
│   ├── assignment-assistant/
│   │   └── route.ts
│   ├── assignments/
│   │   └── ai-suggest-stream/
│   │       └── route.ts
│   ├── chat/
│   │   ├── upload/
│   │   │   └── route.ts
│   │   └── route.ts
│   ├── extraction-worker/
│   │   └── kick/
│   │       └── route.ts
│   ├── extraction/
│   │   └── page/
│   │       └── route.ts
│   ├── feeds/
│   │   └── [token]/
│   │       └── route.ts
│   ├── jobs-worker/
│   │   └── kick/
│   │       └── route.ts
│   ├── live-classroom/
│   │   ├── converter-health/
│   │   │   └── route.ts
│   │   ├── generate-insights/
│   │   │   └── route.ts
│   │   ├── recording/
│   │   │   └── finalize/
│   │   │       └── route.ts
│   │   ├── render-deck/
│   │   │   └── route.ts
│   │   ├── scribe-token/
│   │   │   └── route.ts
│   │   └── scribe-usage/
│   │       └── route.ts
│   ├── notifications/
│   │   └── cron/
│   │       └── route.ts
│   ├── preclass-audio/
│   │   └── generate/
│   │       └── route.ts
│   ├── professor-assistant/
│   │   ├── upload/
│   │   │   └── route.ts
│   │   └── route.ts
│   ├── quizzes/
│   │   └── generate-stream/
│   │       └── route.ts
│   ├── skills/
│   │   └── recompute-sweep/
│   │       └── route.ts
│   └── webhooks/
│       └── resend/
│           └── route.ts
├── auth/
│   └── callback/
│       └── route.ts
├── c/
│   └── [publicId]/
│       ├── opengraph-image.tsx
│       └── page.tsx
├── catalog/
│   └── page.tsx
├── contact/
│   └── page.tsx
├── i/
│   └── [shortId]/
│       ├── InviteRedirectClient.tsx
│       └── page.tsx
├── favicon.ico
├── global-error.tsx
├── globals.css
├── layout.tsx
├── not-found.tsx
└── page.tsx
```

</details>

### 📁 `src/components/` — 635 files

All UI components, namespaced by role or concern — nothing lives under `src/app/`. `ui/` is the primitive layer (shadcn/Radix + house primitives like `empty-state`, `dead-end`, `stat-card`); `shared/` is role-agnostic app components (chat engine, markdown+LaTeX, quiz state contexts). The role trees are `professor/` (315 files — assignments Studio, Quiz Studio, Athena console, live classroom, warehouse, calendar), `student/` (152 — Athena dock, quiz player, projects, intel), `admin/`, `super-admin/`. Almost everything is `'use client'`; only 33 files are server-safe.

<details>
<summary>📂 Expand complete tree for <code>src/components/</code> (635 files)</summary>

```
components/
├── admin/
│   ├── admins/
│   │   └── AdminTeamView.tsx
│   ├── courses/
│   │   ├── AddSectionDialog.tsx
│   │   ├── CourseDetailView.tsx
│   │   ├── CourseForm.tsx
│   │   ├── CourseTable.tsx
│   │   ├── CreateCourseDialog.tsx
│   │   ├── DeleteCourseDialog.tsx
│   │   ├── DeleteSectionDialog.tsx
│   │   ├── EditSectionDialog.tsx
│   │   └── ScheduleDisplay.tsx
│   ├── departments/
│   │   ├── AddFacultyDialog.tsx
│   │   ├── CreateDepartmentDialog.tsx
│   │   ├── DeleteDepartmentDialog.tsx
│   │   ├── DepartmentCardGrid.tsx
│   │   ├── DepartmentForm.tsx
│   │   └── FacultyTable.tsx
│   ├── enrollments/
│   │   ├── EnrollStudentDialog.tsx
│   │   ├── StudentEnrollmentsTable.tsx
│   │   ├── UnenrollDialog.tsx
│   │   └── UpdateEnrollmentDialog.tsx
│   ├── feedback/
│   │   ├── feedback-README.md
│   │   ├── FeedbackDashboard.tsx
│   │   └── FeedbackDetailSheet.tsx
│   ├── professors/
│   │   ├── CreateProfessorDialog.tsx
│   │   ├── DeleteProfessorDialog.tsx
│   │   ├── ProfessorCardGrid.tsx
│   │   ├── ProfessorCoursesTable.tsx
│   │   └── ProfessorForm.tsx
│   ├── programs/
│   │   ├── CreateProgramDialog.tsx
│   │   ├── DeleteProgramDialog.tsx
│   │   ├── ProgramCardGrid.tsx
│   │   └── ProgramForm.tsx
│   ├── staff-requests/
│   │   └── StaffRequestQueue.tsx
│   ├── staff/
│   │   ├── StaffDirectoryTable.tsx
│   │   └── StaffHub.tsx
│   ├── students/
│   │   ├── BulkAddStudentsDialog.tsx
│   │   ├── CreateStudentDialog.tsx
│   │   ├── DeleteStudentDialog.tsx
│   │   ├── EnrollmentPolicyCard.tsx
│   │   ├── StudentCardGrid.tsx
│   │   └── StudentForm.tsx
│   └── visual/
│       └── SupabaseArchitectureVisual.tsx
├── assignments/
│   ├── CodeFileViewer.tsx
│   ├── FilePreviewLink.tsx
│   ├── NotebookCells.tsx
│   ├── NotebookViewer.tsx
│   ├── SubmissionFileViewer.tsx
│   ├── SubquestionCommentThread.tsx
│   └── ZipExplorer.tsx
├── certificates/
│   ├── CertificateShareButtons.tsx
│   └── CertificateView.tsx
├── dashboard/
│   ├── CONTEXT.md
│   ├── DashboardHeader.tsx
│   ├── NotificationBell.tsx
│   ├── PreferencesDialog.tsx
│   ├── Sidebar.tsx
│   ├── SidebarMobile.tsx
│   └── SuspendedSignOutButton.tsx
├── landing/
│   ├── DeskFilm.tsx
│   ├── landing-README.md
│   ├── LandingHero.tsx
│   ├── LandingPage.tsx
│   ├── LandingSections.tsx
│   ├── OutroFilm.tsx
│   └── ProductTour.tsx
├── live-classroom/
│   └── shared/
│       ├── AnnotationToolbar.tsx
│       ├── LiveClassName.tsx
│       ├── NewInteractionComposer.tsx
│       ├── ProgressBar.tsx
│       ├── QuizCountdown.tsx
│       ├── QuizHistoryList.tsx
│       ├── QuizReview.tsx
│       ├── RecordingPlayer.tsx
│       ├── RoomTimeline.tsx
│       ├── shared-README.md
│       └── SlideAnnotationLayer.tsx
├── notifications/
│   ├── notification-icons.ts
│   ├── NotificationHistoryList.tsx
│   └── NotificationPreferencesPanel.tsx
├── professor/
│   ├── about/
│   │   ├── block-editor/
│   │   │   ├── athena-about-adapter.ts
│   │   │   ├── block-factory.ts
│   │   │   ├── block-utils.ts
│   │   │   ├── BlockEditorContext.tsx
│   │   │   ├── constants.ts
│   │   │   ├── index.ts
│   │   │   ├── starter-template.ts
│   │   │   └── use-block-reducer.ts
│   │   ├── blocks/
│   │   │   ├── editors/
│   │   │   │   ├── CalloutBlockEditor.tsx
│   │   │   │   ├── ContactBlockEditor.tsx
│   │   │   │   ├── DividerBlockEditor.tsx
│   │   │   │   ├── FaqBlockEditor.tsx
│   │   │   │   ├── HeroBlockEditor.tsx
│   │   │   │   ├── HighlightBlockEditor.tsx
│   │   │   │   ├── ImageBlockEditor.tsx
│   │   │   │   ├── OutcomesBlockEditor.tsx
│   │   │   │   ├── QuoteBlockEditor.tsx
│   │   │   │   ├── SyllabusBlockEditor.tsx
│   │   │   │   ├── TableBlockEditor.tsx
│   │   │   │   ├── TextBlockEditor.tsx
│   │   │   │   └── VideoBlockEditor.tsx
│   │   │   ├── previews/
│   │   │   │   ├── CalloutBlockPreview.tsx
│   │   │   │   ├── ContactBlockPreview.tsx
│   │   │   │   ├── DividerBlockPreview.tsx
│   │   │   │   ├── FaqBlockPreview.tsx
│   │   │   │   ├── HeroBlockPreview.tsx
│   │   │   │   ├── HighlightBlockPreview.tsx
│   │   │   │   ├── ImageBlockPreview.tsx
│   │   │   │   ├── OutcomesBlockPreview.tsx
│   │   │   │   ├── QuoteBlockPreview.tsx
│   │   │   │   ├── SyllabusBlockPreview.tsx
│   │   │   │   ├── TableBlockPreview.tsx
│   │   │   │   ├── TextBlockPreview.tsx
│   │   │   │   └── VideoBlockPreview.tsx
│   │   │   ├── BlockPreviewRenderer.tsx
│   │   │   ├── BlockRenderer.tsx
│   │   │   ├── BlockToolbar.tsx
│   │   │   ├── HeroSlot.tsx
│   │   │   └── SortableBlockWrapper.tsx
│   │   ├── selectors/
│   │   │   ├── color-selector.tsx
│   │   │   ├── link-selector.tsx
│   │   │   ├── node-selector.tsx
│   │   │   └── text-buttons.tsx
│   │   ├── AboutPageBuilder.tsx
│   │   ├── BlockCanvas.tsx
│   │   ├── BlockEditorHeader.tsx
│   │   ├── BlockPreview.tsx
│   │   ├── extensions.ts
│   │   └── slash-command.tsx
│   ├── analytics/
│   │   ├── analytics-README.md
│   │   ├── ClassAnalyticsDashboard.tsx
│   │   ├── QuizTrendChart.tsx
│   │   └── SkillPerformanceChart.tsx
│   ├── announcements/
│   │   ├── AnnouncementDetail.tsx
│   │   ├── AnnouncementEditor.tsx
│   │   ├── AnnouncementForm.tsx
│   │   ├── AnnouncementList.tsx
│   │   ├── CreateAnnouncementDialog.tsx
│   │   ├── DeleteAnnouncementDialog.tsx
│   │   └── StudentPicker.tsx
│   ├── assignments/
│   │   ├── athena/
│   │   │   ├── actions.ts
│   │   │   ├── AssignmentAthenaDock.tsx
│   │   │   ├── AssignmentAthenaPanel.tsx
│   │   │   ├── AthenaAskLine.tsx
│   │   │   └── QuizModuleCard.tsx
│   │   ├── studio/
│   │   │   ├── shared/
│   │   │   │   ├── block-export.ts
│   │   │   │   ├── BlockChrome.tsx
│   │   │   │   ├── CellImageUploadButton.tsx
│   │   │   │   ├── CellPedagogy.tsx
│   │   │   │   ├── CodeBlock.tsx
│   │   │   │   ├── CollapsibleCard.tsx
│   │   │   │   ├── document-html.ts
│   │   │   │   ├── EquationPalette.tsx
│   │   │   │   ├── export-html.tsx
│   │   │   │   ├── InspectorPanel.tsx
│   │   │   │   ├── SaveAssignmentDialog.tsx
│   │   │   │   ├── SolverPanel.tsx
│   │   │   │   ├── StudioChrome.tsx
│   │   │   │   ├── StudioHeader.tsx
│   │   │   │   ├── StudioMarkdown.tsx
│   │   │   │   ├── SupportingFilesStep.tsx
│   │   │   │   ├── SymbolMenu.tsx
│   │   │   │   ├── TableGridPicker.tsx
│   │   │   │   ├── TemplateHistoryList.tsx
│   │   │   │   ├── trailing-node.ts
│   │   │   │   ├── useExitGuard.ts
│   │   │   │   └── ViewAsStudentToggle.tsx
│   │   │   ├── actions.ts
│   │   │   ├── AnnotationLayer.tsx
│   │   │   ├── athena-document-adapter.ts
│   │   │   ├── athena-document-blocks.ts
│   │   │   ├── CalloutNode.tsx
│   │   │   ├── ChartNode.tsx
│   │   │   ├── document-slash-command.tsx
│   │   │   ├── documentExtensions.ts
│   │   │   ├── DocumentReadOnly.tsx
│   │   │   ├── DocumentStudio.tsx
│   │   │   ├── DownloadDocumentButton.tsx
│   │   │   ├── EquationNode.tsx
│   │   │   ├── FileUploadStudio.tsx
│   │   │   ├── GraphNode.tsx
│   │   │   ├── ImageNode.tsx
│   │   │   ├── MapNode.tsx
│   │   │   ├── MatchNode.tsx
│   │   │   ├── NotebookCanvas.tsx
│   │   │   ├── NotebookCellView.tsx
│   │   │   ├── NotebookCompose.tsx
│   │   │   ├── NotebookInspector.tsx
│   │   │   ├── NotebookPalette.tsx
│   │   │   ├── PublishPanel.tsx
│   │   │   ├── ResizableColumn.tsx
│   │   │   ├── SolverNode.tsx
│   │   │   ├── StemCompose.tsx
│   │   │   ├── studio-ops.ts
│   │   │   ├── StudioRightPalette.tsx
│   │   │   ├── StudioShell.tsx
│   │   │   └── YoutubeNode.tsx
│   │   ├── verbal/
│   │   │   ├── VerbalCellView.tsx
│   │   │   ├── VerbalCompose.tsx
│   │   │   ├── VerbalPalette.tsx
│   │   │   ├── VerbalStudio.tsx
│   │   │   └── VerbalSubmissionReview.tsx
│   │   ├── AnswerKeyStudio.tsx
│   │   ├── AssignmentAnswerKeyCard.tsx
│   │   ├── AssignmentDetailTabs.tsx
│   │   ├── AssignmentMetaEditor.tsx
│   │   ├── AssignmentModuleTags.tsx
│   │   ├── AssignmentPdfCard.tsx
│   │   ├── AssignmentProctoringReport.tsx
│   │   ├── AssignmentsManager.tsx
│   │   ├── AssignmentStudioEntry.tsx
│   │   ├── AssignmentTitleEditor.tsx
│   │   ├── CoreCreatorCards.tsx
│   │   ├── CreateAssignmentWizard.tsx
│   │   ├── GenerationProgress.tsx
│   │   ├── MarketplaceBrowser.tsx
│   │   ├── PlainAssignmentActions.tsx
│   │   ├── ProfessorAssignmentGrader.tsx
│   │   ├── PublishGradesButton.tsx
│   │   ├── RubricEditor.tsx
│   │   ├── TemplateCard.tsx
│   │   ├── TemplateMiniPreview.tsx
│   │   └── TemplateQuickLook.tsx
│   ├── assistant/
│   │   ├── cards/
│   │   │   ├── AlignmentJobChip.tsx
│   │   │   ├── AnnouncementDraftCard.tsx
│   │   │   ├── AssignmentDraftCard.tsx
│   │   │   ├── CardShell.tsx
│   │   │   ├── ChallengeDraftCard.tsx
│   │   │   ├── DifferentiatedDraftCard.tsx
│   │   │   ├── DiscussionDraftCard.tsx
│   │   │   ├── DraftCardRouter.tsx
│   │   │   ├── FeedbackDraftCard.tsx
│   │   │   ├── InsightsCard.tsx
│   │   │   ├── LiveClassReportCard.tsx
│   │   │   ├── MarkdownField.tsx
│   │   │   ├── ModuleDraftCard.tsx
│   │   │   ├── OutcomeCoverageCard.tsx
│   │   │   ├── ProjectDraftCard.tsx
│   │   │   ├── ReplyDraftCard.tsx
│   │   │   ├── RubricDraftCard.tsx
│   │   │   └── StudentPerformanceCard.tsx
│   │   ├── actions.ts
│   │   ├── AssistantConsole.tsx
│   │   └── AthenaUsageNotice.tsx
│   ├── calendar/
│   │   ├── calendar-context/
│   │   │   ├── CalendarContext.tsx
│   │   │   ├── index.ts
│   │   │   └── use-calendar-reducer.ts
│   │   ├── AddToCalendarDialog.tsx
│   │   ├── CalendarEventForm.tsx
│   │   ├── CalendarManager.tsx
│   │   ├── CalendarToolbar.tsx
│   │   ├── CancelMeetingDialog.tsx
│   │   ├── CreateOfficeHoursDialog.tsx
│   │   ├── DayColumnHeader.tsx
│   │   ├── DayView.tsx
│   │   ├── EditEventDialog.tsx
│   │   ├── event-colors.ts
│   │   ├── MeetingCard.tsx
│   │   ├── MeetingDetailDialog.tsx
│   │   ├── MonthView.tsx
│   │   ├── OfficeHoursForm.tsx
│   │   ├── ReadOnlyEventBlock.tsx
│   │   ├── TimeGutter.tsx
│   │   └── WeekView.tsx
│   ├── camera-test/
│   │   └── CameraConfigTest.tsx
│   ├── challenges/
│   │   ├── CertificatesPanel.tsx
│   │   ├── ChallengeBoard.tsx
│   │   ├── ChallengeCard.tsx
│   │   ├── CreateChallengeDialog.tsx
│   │   ├── ReviewPanel.tsx
│   │   └── SkillPickerDialog.tsx
│   ├── dashboard/
│   │   ├── CoursePicker.tsx
│   │   ├── dashboard-README.md
│   │   ├── GradingQueueCard.tsx
│   │   └── QuickActionsPanel.tsx
│   ├── discussions/
│   │   ├── discussions-README.md
│   │   └── ProfessorDiscussionsPage.tsx
│   ├── enrollment/
│   │   └── RosterPage.tsx
│   ├── grades/
│   │   ├── GradebookTable.tsx
│   │   ├── grades-README.md
│   │   ├── SetGradeDialog.tsx
│   │   └── StudentAnalyticsView.tsx
│   ├── live-classroom/
│   │   ├── ClassroomDashboard.tsx
│   │   ├── DeckSwitcher.tsx
│   │   ├── InteractionComposer.tsx
│   │   ├── live-classroom-README.md
│   │   ├── LivePresenter.tsx
│   │   ├── LiveQuizButton.tsx
│   │   ├── PreClassInteractionPrep.tsx
│   │   ├── PreClassSetup.tsx
│   │   ├── PresenceChip.tsx
│   │   ├── ProfessorQuizHistory.tsx
│   │   ├── ProjectorView.tsx
│   │   ├── QuestionPanel.tsx
│   │   ├── QuizConceptAnalytics.tsx
│   │   ├── ReactionBadges.tsx
│   │   ├── RecordingControl.tsx
│   │   ├── ScheduleSessionDialog.tsx
│   │   ├── SessionReportView.tsx
│   │   ├── TranscriptionIndicator.tsx
│   │   ├── TranscriptionPanel.tsx
│   │   ├── UpcomingSessions.tsx
│   │   └── UploadDeckDialog.tsx
│   ├── modules/
│   │   ├── AddItemPopover.tsx
│   │   ├── CreateModuleDialog.tsx
│   │   ├── DeleteModuleDialog.tsx
│   │   ├── EditItemDialog.tsx
│   │   ├── ModuleDividerDialog.tsx
│   │   ├── ModuleDividerRow.tsx
│   │   ├── ModuleRowActions.tsx
│   │   ├── ModulesBoard.tsx
│   │   ├── PickFromLibraryDialog.tsx
│   │   ├── PrimerControl.tsx
│   │   ├── ProfessorModuleItemRow.tsx
│   │   └── ProfessorModuleSection.tsx
│   ├── onboarding/
│   │   ├── OnboardingGate.tsx
│   │   └── ProfessorOnboardingForm.tsx
│   ├── projects/
│   │   ├── CreateProjectDialog.tsx
│   │   ├── DeleteProjectDialog.tsx
│   │   ├── ProjectDetail.tsx
│   │   ├── ProjectList.tsx
│   │   ├── ProjectOverviewTab.tsx
│   │   ├── ProjectTeamsTab.tsx
│   │   └── TeamDetailView.tsx
│   ├── quizzes/
│   │   ├── wizard/
│   │   │   ├── AddQuestionHub.tsx
│   │   │   ├── AddQuestionSplitButton.tsx
│   │   │   ├── PickFromBankDialog.tsx
│   │   │   ├── QuestionEditorCard.tsx
│   │   │   ├── QuestionSourceChip.tsx
│   │   │   ├── QuizInfoStep.tsx
│   │   │   ├── QuizReviewStep.tsx
│   │   │   ├── QuizSettingsDrawer.tsx
│   │   │   ├── QuizStudio.tsx
│   │   │   ├── QuizStudioQuestionSidebar.tsx
│   │   │   ├── QuizStudioRail.tsx
│   │   │   ├── UploadJSONDialog.tsx
│   │   │   └── wizard-README.md
│   │   ├── DeleteQuestionDialog.tsx
│   │   ├── DeleteQuizDialog.tsx
│   │   ├── InlineBlankEditor.tsx
│   │   ├── InsertFromLibraryDialog.tsx
│   │   ├── ProctoringDashboard.tsx
│   │   ├── ProctoringDetailView.tsx
│   │   ├── QuestionBankManager.tsx
│   │   ├── QuestionBankToolbar.tsx
│   │   ├── QuestionCard.tsx
│   │   ├── QuestionFormDialog.tsx
│   │   ├── QuestionList.tsx
│   │   ├── QuizCard.tsx
│   │   ├── QuizDashboard.tsx
│   │   ├── QuizInsightsDashboard.tsx
│   │   ├── QuizList.tsx
│   │   ├── QuizTimeChart.tsx
│   │   ├── SnapshotGallery.tsx
│   │   └── StudentSubmissionPage.tsx
│   ├── roadmap/
│   │   ├── ModulePlacementDialog.tsx
│   │   └── SetupSpotlight.tsx
│   ├── settings/
│   │   ├── CloneFromSectionDialog.tsx
│   │   └── CourseSettingsForm.tsx
│   ├── skills/
│   │   ├── focus-trap.ts
│   │   ├── SkillExtractionNotifier.tsx
│   │   ├── SkillIndexView.tsx
│   │   ├── SkillMasteryExperience.tsx
│   │   ├── SkillMasterySettings.tsx
│   │   └── SkillsManager.tsx
│   ├── staff/
│   │   ├── staff-README.md
│   │   ├── StaffFeaturePage.tsx
│   │   ├── StaffList.tsx
│   │   └── SubmitStaffRequestDialog.tsx
│   ├── warehouse/
│   │   ├── warehouse-context/
│   │   │   ├── index.ts
│   │   │   ├── use-warehouse-reducer.ts
│   │   │   └── WarehouseContext.tsx
│   │   ├── DeleteFileDialog.tsx
│   │   ├── DeleteShelfDialog.tsx
│   │   ├── FavoritesSection.tsx
│   │   ├── FileCard.tsx
│   │   ├── FileDetailPanel.tsx
│   │   ├── FolderTree.tsx
│   │   ├── MoveFileDialog.tsx
│   │   ├── QuickNotePopover.tsx
│   │   ├── RecentFilesSection.tsx
│   │   ├── ShelfCard.tsx
│   │   ├── StorageHealthCard.tsx
│   │   ├── TimelineTermSection.tsx
│   │   ├── UploadFileDialog.tsx
│   │   ├── WarehouseFolderView.tsx
│   │   ├── WarehouseManager.tsx
│   │   ├── WarehouseShelfView.tsx
│   │   ├── WarehouseTimelineView.tsx
│   │   ├── WarehouseToolbar.tsx
│   │   └── WeekBox.tsx
│   ├── CourseBreadcrumbs.tsx
│   ├── CourseSidebar.tsx
│   ├── DraftFeatureBanner.tsx
│   └── PageHeader.tsx
├── shared/
│   ├── announcements/
│   │   └── RichContentRenderer.tsx
│   ├── athena/
│   │   └── AttachmentChip.tsx
│   ├── auto-roadmap/
│   │   ├── AutoRoadmapSkeleton.tsx
│   │   ├── RoadmapEmptyState.tsx
│   │   ├── RoadmapLoadError.tsx
│   │   └── RoadmapPaper.tsx
│   ├── chat/
│   │   ├── ChatArea.tsx
│   │   ├── ChatInput.tsx
│   │   ├── DmView.tsx
│   │   ├── MessageBubble.tsx
│   │   ├── PeoplePanel.tsx
│   │   └── ReactionBar.tsx
│   ├── modules/
│   │   ├── DividerRule.tsx
│   │   ├── module-href.ts
│   │   ├── module-item-display.ts
│   │   ├── module-rows.ts
│   │   └── ModulesToolbar.tsx
│   ├── quiz/
│   │   └── quiz-context/
│   │       ├── index.ts
│   │       ├── QuestionBankContext.tsx
│   │       ├── QuizPlayerContext.tsx
│   │       ├── use-quiz-player-reducer.ts
│   │       └── use-quiz-reducer.ts
│   ├── BrandMark.tsx
│   ├── CalendarFeedCard.tsx
│   ├── DashboardGreeting.tsx
│   ├── DocumentPagePreview.tsx
│   ├── FeedbackWidget.tsx
│   ├── ImportCalendarDialog.tsx
│   ├── LocalDateTime.tsx
│   ├── MarkdownLatex.tsx
│   ├── QuizCodeBlock.tsx
│   ├── SetPasswordDialog.tsx
│   └── TodoList.tsx
├── student/
│   ├── announcements/
│   │   ├── AcknowledgeCard.tsx
│   │   ├── AllStudentAnnouncements.tsx
│   │   ├── CommentSection.tsx
│   │   ├── ReactionBar.tsx
│   │   ├── ReadTracker.tsx
│   │   └── StudentAnnouncementList.tsx
│   ├── assignments/
│   │   ├── AssessmentRunner.tsx
│   │   ├── RubricLossChart.tsx
│   │   ├── StudentAssignmentWorkspace.tsx
│   │   ├── StudentGradePanel.tsx
│   │   ├── StudentNotebookView.tsx
│   │   ├── StudentRubricBreakdown.tsx
│   │   └── VerbalAssessmentRunner.tsx
│   ├── athena/
│   │   ├── ArtifactWidgets.tsx
│   │   ├── AthenaChat.tsx
│   │   ├── AthenaComposer.tsx
│   │   ├── AthenaCourseBeacon.tsx
│   │   ├── AthenaEntryPill.tsx
│   │   ├── AthenaHistoryRail.tsx
│   │   ├── AthenaRunCard.tsx
│   │   ├── AthenaShell.tsx
│   │   └── ChatMessage.tsx
│   ├── calendar/
│   │   ├── CalendarColorSettings.tsx
│   │   ├── CalendarColorsInit.tsx
│   │   ├── event-style.ts
│   │   ├── EventDetailCard.tsx
│   │   ├── EventHoverCard.tsx
│   │   ├── PersonalEventsManager.tsx
│   │   ├── StudentCalendar.tsx
│   │   ├── StudentMonthView.tsx
│   │   └── StudentTimeGrid.tsx
│   ├── challenges/
│   │   ├── ChallengeBoard.tsx
│   │   ├── ChallengeCard.tsx
│   │   ├── StudentCertificates.tsx
│   │   └── SubmitSolutionDialog.tsx
│   ├── courses/
│   │   ├── DropDialog.tsx
│   │   ├── StudentCourseGrid.tsx
│   │   └── StudentCourseSidebar.tsx
│   ├── dashboard/
│   │   ├── MiniCalendar.tsx
│   │   ├── RecentAnnouncements.tsx
│   │   └── WeeklyCompletion.tsx
│   ├── discussions/
│   │   ├── DiscussionChannelSidebar.tsx
│   │   ├── discussions-README.md
│   │   └── StudentDiscussionsPage.tsx
│   ├── grades/
│   │   ├── GradesTable.tsx
│   │   ├── StudentGradeCategories.tsx
│   │   ├── StudentQuizScoresTable.tsx
│   │   └── StudentSkillInsights.tsx
│   ├── intel/
│   │   ├── AddTipDialog.tsx
│   │   ├── AnonymousToggle.tsx
│   │   ├── AnswerCard.tsx
│   │   ├── AnswerForm.tsx
│   │   ├── AskQuestionDialog.tsx
│   │   ├── IntelOverview.tsx
│   │   ├── IntelPanel.tsx
│   │   ├── IntelProfessorInsights.tsx
│   │   ├── IntelQA.tsx
│   │   ├── IntelResources.tsx
│   │   ├── IntelReviews.tsx
│   │   ├── IntelSurvivalGuide.tsx
│   │   ├── QuestionCard.tsx
│   │   ├── RatingStars.tsx
│   │   ├── ResourceCard.tsx
│   │   ├── ReviewCard.tsx
│   │   ├── TipCard.tsx
│   │   ├── UploadResourceDialog.tsx
│   │   ├── UpvoteButton.tsx
│   │   └── WriteReviewDialog.tsx
│   ├── live-classroom/
│   │   ├── AiQuizResponder.tsx
│   │   ├── AnnotatedSlidesSection.tsx
│   │   ├── AskQuestionForm.tsx
│   │   ├── CatchMeUp.tsx
│   │   ├── FlashcardDeck.tsx
│   │   ├── InteractionResponder.tsx
│   │   ├── live-classroom-README.md
│   │   ├── LiveNotesEditor.tsx
│   │   ├── PracticeQuizPlayer.tsx
│   │   ├── QuestionList.tsx
│   │   ├── RecordingBanner.tsx
│   │   ├── SectionRoomWatcher.tsx
│   │   ├── StudentClassroomView.tsx
│   │   ├── StudentInsightsView.tsx
│   │   ├── StudentLiveView.tsx
│   │   ├── StudentQuizHistory.tsx
│   │   ├── StudentQuizReviewList.tsx
│   │   └── StudentReactionBar.tsx
│   ├── modules/
│   │   ├── ModulesLoadError.tsx
│   │   ├── StudentModuleItemRow.tsx
│   │   ├── StudentModuleSection.tsx
│   │   ├── StudentModulesList.tsx
│   │   └── types.ts
│   ├── office-hours/
│   │   ├── office-hours-context/
│   │   │   ├── BookingContext.tsx
│   │   │   ├── index.ts
│   │   │   └── use-booking-reducer.ts
│   │   ├── AvailableSlotsList.tsx
│   │   ├── BookingCard.tsx
│   │   ├── BookSlotDialog.tsx
│   │   ├── MyBookingsPanel.tsx
│   │   ├── OfficeHoursBooking.tsx
│   │   └── ProfessorSelector.tsx
│   ├── primers/
│   │   └── StudentPrimerButton.tsx
│   ├── profile/
│   │   ├── AboutMeSection.tsx
│   │   ├── ChangePasswordSection.tsx
│   │   ├── ProfessionalLinks.tsx
│   │   ├── ProfilePhoto.tsx
│   │   └── StudentProfilePage.tsx
│   ├── projects/
│   │   ├── chat/
│   │   │   ├── ChannelSidebar.tsx
│   │   │   ├── chat-README.md
│   │   │   ├── ChatArea.tsx
│   │   │   ├── ChatInput.tsx
│   │   │   ├── DocMentionChip.tsx
│   │   │   ├── MentionPicker.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── PhaseMentionChip.tsx
│   │   │   └── SystemMessageLine.tsx
│   │   ├── docs/
│   │   │   ├── CanvasTypePickerDialog.tsx
│   │   │   ├── DocEditorDialog.tsx
│   │   │   ├── docs-README.md
│   │   │   └── ProjectResourcesSection.tsx
│   │   ├── meetings/
│   │   │   ├── AvailabilityGrid.tsx
│   │   │   ├── JoinMeetingButton.tsx
│   │   │   ├── MeetingRoomCard.tsx
│   │   │   ├── MeetingsPanel.tsx
│   │   │   └── TeamWorkspacePanel.tsx
│   │   ├── AIGeneratePhasesDialog.tsx
│   │   ├── CreateTeamDialog.tsx
│   │   ├── ExportProjectPlanButton.tsx
│   │   ├── PlanningEditor.tsx
│   │   ├── StudentDiscussionsTab.tsx
│   │   ├── StudentPhasesTab.tsx
│   │   ├── StudentProjectDetail.tsx
│   │   ├── StudentProjectList.tsx
│   │   ├── StudentSubmissionTab.tsx
│   │   ├── StudentTeamDetail.tsx
│   │   └── StudentTeamTab.tsx
│   └── quizzes/
│       ├── AdaptiveQuizPlayer.tsx
│       ├── AdaptiveResults.tsx
│       ├── CameraIndicator.tsx
│       ├── FlaggedReviewScreen.tsx
│       ├── FormulaSheetPanel.tsx
│       ├── QuestionDisplay.tsx
│       ├── QuestionNavigator.tsx
│       ├── QuestionReviewCard.tsx
│       ├── QuizLeaderboard.tsx
│       ├── QuizPlayer.tsx
│       ├── QuizResults.tsx
│       ├── QuizTimerBar.tsx
│       ├── ScoreCircle.tsx
│       ├── StudentQuizCard.tsx
│       ├── StudentQuizDetail.tsx
│       ├── StudentQuizList.tsx
│       └── SubmitConfirmDialog.tsx
├── super-admin/
│   ├── cost-analysis/
│   │   ├── bits.tsx
│   │   ├── categories.ts
│   │   └── CostCharts.tsx
│   ├── institutions/
│   │   ├── CreateInstitutionForm.tsx
│   │   ├── InstitutionDetailHeader.tsx
│   │   ├── InstitutionsTable.tsx
│   │   ├── InstitutionUsersList.tsx
│   │   ├── InviteAdminCard.tsx
│   │   ├── ResendAdminInviteButton.tsx
│   │   └── StatusPill.tsx
│   ├── team/
│   │   └── SuperAdminTeamView.tsx
│   └── super-admin-README.md
└── ui/
    ├── accordion.tsx
    ├── alert-dialog.tsx
    ├── alert.tsx
    ├── animated-counter.tsx
    ├── animated-list.tsx
    ├── avatar.tsx
    ├── badge.tsx
    ├── breadcrumbs.tsx
    ├── button.tsx
    ├── capacity-bar.tsx
    ├── card.tsx
    ├── chart.tsx
    ├── checkbox.tsx
    ├── collapsible.tsx
    ├── dead-end.tsx
    ├── dialog.tsx
    ├── dropdown-menu.tsx
    ├── empty-state.tsx
    ├── file-upload.tsx
    ├── form.tsx
    ├── hover-card.tsx
    ├── input.tsx
    ├── label.tsx
    ├── material-viewer.tsx
    ├── numeric-input.tsx
    ├── popover.tsx
    ├── portal-container.tsx
    ├── progress.tsx
    ├── resizable.tsx
    ├── scroll-area.tsx
    ├── select.tsx
    ├── separator.tsx
    ├── sheet.tsx
    ├── skeleton.tsx
    ├── sonner.tsx
    ├── stat-card.tsx
    ├── status-indicator.tsx
    ├── switch.tsx
    ├── table.tsx
    ├── tabs.tsx
    ├── textarea.tsx
    ├── toggle-group.tsx
    ├── toggle.tsx
    └── tooltip.tsx
```

</details>

### 📁 `src/lib/` — 427 files

The domain layer: 38 subdirectories + 9 top-level files (~87k lines). The load-bearing ones: `supabase/` (client factories, the 6,074-line `queries.ts`, generated `types.ts`), `auth/` (the authorization gates — the real access control, since mutations use the RLS-bypassing admin client), `ai/` (Gemini client, prompts, cost ledger, the three Athena surfaces), `pinecone/` (the vector-store tenant wall), `live-classroom/` (64 files — the realtime broadcast architecture), `quiz/`, `skills/`, `jobs/` (background pipelines), `extraction/`, `validations/` (51 Zod schema files), `events/` (the shared feed layer). See [6-file-insights.md](./6-file-insights.md) for the deep dive.

<details>
<summary>📂 Expand complete tree for <code>src/lib/</code> (427 files)</summary>

```
lib/
├── admin/
│   └── provision-student.ts
├── ai/
│   ├── assignment-assistant/
│   │   ├── templates/
│   │   │   └── registry.ts
│   │   ├── context.ts
│   │   ├── diff.ts
│   │   ├── prompts.ts
│   │   ├── schemas.ts
│   │   ├── tools.ts
│   │   └── turn-state.ts
│   ├── elevenlabs/
│   │   ├── stt.ts
│   │   ├── tts.ts
│   │   └── voices.ts
│   ├── professor-assistant/
│   │   ├── context.ts
│   │   ├── models.ts
│   │   ├── outcome-coverage.ts
│   │   ├── persistence.ts
│   │   ├── prompts.ts
│   │   ├── rate-limit.ts
│   │   ├── schemas.ts
│   │   ├── student-resolve.ts
│   │   ├── tools.ts
│   │   └── translate.ts
│   ├── student-tutor/
│   │   ├── artifact-store.ts
│   │   ├── booking-note.ts
│   │   ├── challenge-match.ts
│   │   ├── class-question.ts
│   │   ├── class-transcript.ts
│   │   ├── contract.ts
│   │   ├── knowledge-map.ts
│   │   ├── quiz-history.ts
│   │   ├── quiz-review.ts
│   │   ├── study-artifact.ts
│   │   └── tools.ts
│   ├── athena-attachments-server.ts
│   ├── athena-attachments.ts
│   ├── athena-directive.ts
│   ├── class-insight.ts
│   ├── config.ts
│   ├── conversation-utils.ts
│   ├── cost-aggregate.ts
│   ├── cost.ts
│   ├── embeddings.ts
│   ├── grounding.ts
│   ├── llm-client.ts
│   ├── node-check.ts
│   ├── prompt-fence.ts
│   ├── prompts.ts
│   ├── quiz-quality.ts
│   ├── streaming-blocks.ts
│   ├── student-insight.ts
│   └── usage.ts
├── announcements/
│   └── rich-content.ts
├── assignments/
│   ├── ai-grading/
│   │   ├── answer-key.ts
│   │   ├── chunk.ts
│   │   ├── grader.ts
│   │   ├── hybrid-grader.ts
│   │   ├── ingest.ts
│   │   ├── invalidate.ts
│   │   ├── keywords.ts
│   │   ├── manual-review.ts
│   │   ├── mode.ts
│   │   ├── references.ts
│   │   ├── signals.ts
│   │   ├── similarity-grader.ts
│   │   ├── suggest.ts
│   │   └── types.ts
│   ├── studio/
│   │   ├── answer-keys.ts
│   │   ├── athena-notebook-adapter.ts
│   │   ├── authoring.ts
│   │   ├── cell-ops.ts
│   │   ├── insert-ops.ts
│   │   ├── links.ts
│   │   ├── marketplace-catalog.ts
│   │   ├── notebook-model.ts
│   │   ├── notebook-templates.ts
│   │   ├── palette.ts
│   │   ├── rubric-source.ts
│   │   ├── sample-images.ts
│   │   ├── template-history.ts
│   │   └── templates.ts
│   ├── verbal/
│   │   ├── athena-verbal-adapter.ts
│   │   ├── config.ts
│   │   ├── seam.ts
│   │   └── verbal-templates.ts
│   ├── assessment.ts
│   ├── files.ts
│   ├── grade-value.ts
│   ├── notebook.ts
│   ├── rubric-ai.ts
│   ├── student-status.ts
│   ├── submissions.ts
│   ├── viewer-actions.ts
│   ├── viewer-auth.ts
│   ├── zip-reader.ts
│   └── zip.ts
├── athena/
│   └── artifact-kinds.ts
├── auth/
│   ├── admin-context.ts
│   ├── assert-tenant-owns.ts
│   ├── section-access.ts
│   ├── super-admin-context.ts
│   └── tenant-context.ts
├── calendar/
│   ├── category-colors.ts
│   ├── feed-builder.ts
│   ├── ical.ts
│   ├── ics-parser.ts
│   ├── professor-events.ts
│   ├── storage.ts
│   ├── student-events.ts
│   └── utils.ts
├── certificates/
│   ├── linkedin.ts
│   └── pdf.ts
├── chat/
│   ├── hooks.ts
│   ├── reactions.ts
│   ├── signed-urls.ts
│   └── system-messages.ts
├── costs/
│   ├── providers/
│   │   ├── elevenlabs.ts
│   │   ├── gcp.ts
│   │   ├── index.ts
│   │   ├── pinecone.ts
│   │   ├── resend.ts
│   │   ├── supabase.ts
│   │   └── types.ts
│   ├── external-rates.ts
│   └── external-usage.ts
├── dashboard/
│   ├── professor-todos.ts
│   └── todos.ts
├── discussion/
│   ├── default-channel.ts
│   ├── discussion-README.md
│   └── hooks.ts
├── dm/
│   └── hooks.ts
├── document-parser/
│   ├── asset-crop.ts
│   ├── document-parser-README.md
│   ├── docx.ts
│   ├── image.ts
│   ├── index-v2.ts
│   ├── index.ts
│   ├── office-to-pdf.ts
│   ├── ooxml.ts
│   ├── page-renderer.ts
│   ├── pdf-tables.ts
│   ├── pdf.ts
│   ├── pptx.ts
│   ├── utils.ts
│   ├── vision.ts
│   └── xlsx.ts
├── events/
│   ├── audience.ts
│   ├── content-change.ts
│   ├── emit.ts
│   ├── feed-actions.ts
│   ├── material-events.ts
│   └── types.ts
├── export/
│   └── project-plan.ts
├── extraction/
│   ├── assets.ts
│   ├── citation.ts
│   ├── enqueue.ts
│   ├── library-queries.ts
│   ├── sanitize.ts
│   └── worker.ts
├── grades/
│   ├── compute.ts
│   └── fetch.ts
├── hooks/
│   ├── use-athena-attachments.ts
│   ├── use-athena-course.ts
│   ├── use-athena-drive-mode.ts
│   ├── use-athena-prefill.ts
│   ├── use-module-expansion.ts
│   └── use-sidebar-rail.ts
├── jobs/
│   ├── pipelines/
│   │   ├── outcome-alignment/
│   │   │   ├── cache.ts
│   │   │   ├── gather.ts
│   │   │   ├── index.ts
│   │   │   ├── map.ts
│   │   │   ├── reduce.ts
│   │   │   └── types.ts
│   │   ├── embed-material.ts
│   │   ├── node-check-pool.ts
│   │   ├── regenerate-student-insights.ts
│   │   ├── render-scheduled-deck.ts
│   │   └── test-noop.ts
│   ├── enqueue.ts
│   ├── notify.ts
│   ├── registry.ts
│   ├── types.ts
│   └── worker.ts
├── live-classroom/
│   ├── attendance/
│   │   └── actions.ts
│   ├── broadcast/
│   │   ├── broadcast-README.md
│   │   ├── event-bus.ts
│   │   ├── observability.ts
│   │   ├── types.ts
│   │   ├── use-drawings.ts
│   │   ├── use-interactions.ts
│   │   ├── use-presence.ts
│   │   ├── use-questions.ts
│   │   ├── use-reactions.ts
│   │   ├── use-room-channel.ts
│   │   ├── use-slide-sync.ts
│   │   └── use-timeline.ts
│   ├── drawings/
│   │   ├── actions.ts
│   │   ├── drawings-README.md
│   │   ├── render.ts
│   │   ├── send-stroke.ts
│   │   └── types.ts
│   ├── history/
│   │   └── actions.ts
│   ├── insights/
│   │   ├── annotated-slides-pdf.ts
│   │   ├── annotated-slides.ts
│   │   ├── compute-student.ts
│   │   ├── generate.ts
│   │   ├── professor-report.ts
│   │   ├── student-actions.ts
│   │   ├── transcript-extraction.ts
│   │   ├── transcript-insights.ts
│   │   └── trigger.ts
│   ├── interactions/
│   │   ├── actions.ts
│   │   ├── aggregates.ts
│   │   └── interactions-README.md
│   ├── notes/
│   │   ├── actions.ts
│   │   └── use-notes.ts
│   ├── reactions/
│   │   ├── constants.ts
│   │   ├── reaction-kinds.tsx
│   │   └── send-reaction.ts
│   ├── recording/
│   │   ├── actions.ts
│   │   ├── finalize.ts
│   │   ├── reconstruct.ts
│   │   ├── trigger.ts
│   │   ├── types.ts
│   │   └── use-recording-capture.ts
│   ├── report/
│   │   ├── actions.ts
│   │   └── compute.ts
│   ├── summary/
│   │   └── actions.ts
│   ├── transcription/
│   │   ├── transcription-README.md
│   │   ├── types.ts
│   │   ├── use-transcription.ts
│   │   └── use-voice-activity.ts
│   ├── audio-devices.ts
│   ├── deck-converter.ts
│   ├── hooks.ts
│   ├── lecture-context.ts
│   ├── live-classroom-README.md
│   ├── promote-deck-material.ts
│   ├── quiz-review.ts
│   ├── recurrence.ts
│   ├── render-deck.ts
│   ├── replay.ts
│   ├── room-auth.ts
│   ├── select-fullscreen-notice.ts
│   ├── shuffle.ts
│   ├── snapshot-utils.ts
│   └── snapshot.ts
├── markdown/
│   └── math.ts
├── meetings/
│   ├── hooks.ts
│   └── overlap.ts
├── modules/
│   ├── unlock.ts
│   └── url-classify.ts
├── notifications/
│   ├── announcement-auto-publish.ts
│   ├── digest.ts
│   ├── meeting-reminder-sweep.ts
│   ├── publish-sweep.ts
│   ├── quiz-results-sweep.ts
│   ├── re-engagement-copy.ts
│   ├── re-engagement.ts
│   └── submission-summary-sweep.ts
├── pinecone/
│   ├── client.ts
│   ├── concept-boost.ts
│   ├── config.ts
│   ├── data.ts
│   ├── embed.ts
│   ├── ids.ts
│   ├── locator.ts
│   ├── metadata.ts
│   ├── namespace.ts
│   └── search.ts
├── preclass-audio/
│   ├── content.ts
│   ├── generate.ts
│   ├── script.ts
│   ├── trigger.ts
│   └── tts.ts
├── proctoring/
│   └── summary.ts
├── quick-actions/
│   ├── quick-actions-README.md
│   ├── registry.ts
│   └── types.ts
├── quiz/
│   ├── irt/
│   │   ├── estimator.ts
│   │   └── grader.ts
│   ├── active-attempt.ts
│   ├── adaptive-engine.ts
│   ├── ai-generation.ts
│   ├── analytics-utils.ts
│   ├── athena-quiz-adapter.ts
│   ├── auto-publish.ts
│   ├── camera-permission.ts
│   ├── concept-plan.ts
│   ├── fill-in-blank.ts
│   ├── formula-insert.ts
│   ├── fullscreen.ts
│   ├── proctoring.ts
│   ├── rate-limit.ts
│   ├── scoring.ts
│   ├── source-citation.ts
│   ├── storage.ts
│   ├── submissions-filter.ts
│   ├── unified-result.ts
│   ├── utils.ts
│   ├── video-proctoring.ts
│   └── wizard-validation.ts
├── roadmap/
│   ├── aggregates.ts
│   ├── annotation-target.ts
│   ├── auto-roadmap-helpers.ts
│   ├── class-insight.ts
│   ├── concept-links.ts
│   ├── concept-refs.ts
│   ├── coverage-loader.ts
│   ├── coverage-signals.ts
│   ├── coverage.ts
│   ├── dossier-facts.ts
│   ├── dossier.ts
│   ├── drawer-actions.ts
│   ├── engagement.ts
│   ├── item-stats.ts
│   ├── journey-state.ts
│   ├── knowledge-path.ts
│   ├── lens-camera.ts
│   ├── node-check.ts
│   ├── node-drawer.ts
│   ├── node-journeys.ts
│   ├── placement-actions.ts
│   ├── placement.ts
│   ├── prototype-adapter.ts
│   ├── roadmap-signals.ts
│   ├── same-page-link.ts
│   ├── study-focus.ts
│   ├── triage.ts
│   └── use-bake-watch.ts
├── routes/
│   ├── safe-path.ts
│   └── student.ts
├── section-staff/
│   └── directory-utils.ts
├── skills/
│   ├── aggregate.ts
│   ├── canonical.ts
│   ├── config.ts
│   ├── grade-hook.ts
│   ├── index-view.ts
│   ├── mastery.ts
│   ├── recompute.ts
│   ├── reconcile.ts
│   ├── roadmap-mastery.ts
│   ├── scoring.ts
│   ├── tier-styles.ts
│   └── tree.ts
├── supabase/
│   ├── about-assets.ts
│   ├── admin.ts
│   ├── chat-storage.ts
│   ├── client.ts
│   ├── CONTEXT.md
│   ├── cookie-options.ts
│   ├── event-logger.ts
│   ├── paged-read.ts
│   ├── queries.ts
│   ├── realtime-auth.ts
│   ├── realtime.ts
│   ├── resolve-join.ts
│   ├── server.ts
│   ├── signed-urls.ts
│   ├── storage.ts
│   └── types.ts
├── tiptap/
│   ├── course-mention-extension.ts
│   └── course-mention-suggestion.tsx
├── validations/
│   ├── adaptive.ts
│   ├── admin-invite.ts
│   ├── announcement-interaction.ts
│   ├── announcement.ts
│   ├── assignment.ts
│   ├── athena-conversation.ts
│   ├── auto-roadmap.ts
│   ├── calendar.ts
│   ├── certificate.ts
│   ├── challenge.ts
│   ├── course-about.ts
│   ├── course-assignment.ts
│   ├── course.ts
│   ├── department.ts
│   ├── direct-messages.ts
│   ├── discussion.ts
│   ├── document-extraction.ts
│   ├── enrollment.ts
│   ├── features.ts
│   ├── feedback.ts
│   ├── grades.ts
│   ├── institution-settings.ts
│   ├── institution.ts
│   ├── intel.ts
│   ├── invite-status.ts
│   ├── lc-class-insights.ts
│   ├── lc-interactions.ts
│   ├── lc-transcript-insights.ts
│   ├── lecture-summary.ts
│   ├── live-classroom.ts
│   ├── module.ts
│   ├── notification-preferences.ts
│   ├── preclass-primer.ts
│   ├── proctoring.ts
│   ├── professor-onboarding.ts
│   ├── professor.ts
│   ├── program.ts
│   ├── project-chat.ts
│   ├── project-docs.ts
│   ├── project.ts
│   ├── quiz.ts
│   ├── roster-import.ts
│   ├── section-staff.ts
│   ├── skill.ts
│   ├── student-profile.ts
│   ├── student.ts
│   ├── studio.ts
│   ├── super-admin-invite.ts
│   ├── team-meeting.ts
│   ├── verbal-assessment.ts
│   └── warehouse.ts
├── warehouse/
│   ├── storage.ts
│   ├── sync.ts
│   └── utils.ts
├── wolfram/
│   ├── client.ts
│   └── format.ts
├── CONTEXT.md
├── course-features.ts
├── datetime.ts
├── email.ts
├── invite-redirects.ts
├── logger.ts
├── site-url.ts
├── slack.ts
├── tiptap-utils.ts
└── utils.ts
```

</details>

### 📁 `src/__tests__/` — 459 files

459 files, ~3.6k Vitest tests. Naming is by prefix: `actions-*` (71 — one per server-action surface), `quiz-*` (33), `athena-*` (30), `lc-*` (24, live classroom), `schema-*` (22, Zod), `roadmap-*`, `ai-*` (AI grading), plus security-focused singles (`auth-callback-open-redirect`, `login-cwid-enumeration-oracle`, `strip-quiz-answers`, ...). `setup.ts` wires jsdom, env, and a reusable Supabase Realtime `mockChannel`; `helpers/` has auth/Supabase mock factories and typed data builders; `fixtures/` carries real-world extraction PDFs.

<details>
<summary>📂 Expand complete tree for <code>src/__tests__/</code> (459 files)</summary>

```
__tests__/
├── fixtures/
│   ├── office/
│   │   └── gen_chart.xlsx
│   ├── tables/
│   │   ├── background_lines_1.pdf
│   │   ├── clockwise_table_1.pdf
│   │   ├── column_span_1.pdf
│   │   ├── foo.pdf
│   │   ├── missing_values.pdf
│   │   ├── row_span_1.pdf
│   │   └── stream_inner_outer_columns.pdf
│   └── README.md
├── helpers/
│   ├── mock-auth.ts
│   ├── mock-supabase.ts
│   └── test-data-builders.ts
├── stubs/
│   └── server-only.ts
├── about-assets.test.ts
├── actions-admin-admins.test.ts
├── actions-admin-course-actions.test.ts
├── actions-admin-departments.test.ts
├── actions-admin-professors.test.ts
├── actions-admin-staff-requests.test.ts
├── actions-admin.test.ts
├── actions-assessment-snapshot.test.ts
├── actions-assignment-attachment-upload.test.ts
├── actions-athena-context.test.ts
├── actions-cell-image-upload.test.ts
├── actions-chat-reactions.test.ts
├── actions-clone-studio-assignment.test.ts
├── actions-dms.test.ts
├── actions-drawer-publish-gate.test.ts
├── actions-drawer-session-gate.test.ts
├── actions-generate-rubric.test.ts
├── actions-grade-submission.test.ts
├── actions-late-submission.test.ts
├── actions-lc-drawings.test.ts
├── actions-lc-interactions.test.ts
├── actions-lc-notes.test.ts
├── actions-lc-session-report.test.ts
├── actions-live-classroom.test.ts
├── actions-node-check-authz.test.ts
├── actions-notifications.test.ts
├── actions-prof-announcements.test.ts
├── actions-prof-assignments-publish.test.ts
├── actions-prof-assistant.test.ts
├── actions-prof-course-features.test.ts
├── actions-prof-discussions.test.ts
├── actions-prof-document.test.ts
├── actions-prof-grades.test.ts
├── actions-prof-modules.test.ts
├── actions-prof-preferences.test.ts
├── actions-prof-projects.test.ts
├── actions-prof-quizzes.test.ts
├── actions-prof-skills.test.ts
├── actions-prof-staff.test.ts
├── actions-prof-unpublish-grades.test.ts
├── actions-professor-calendar.test.ts
├── actions-reopen-window.test.ts
├── actions-roadmap-class-insight.test.ts
├── actions-roadmap-data.test.ts
├── actions-roadmap-dossier.test.ts
├── actions-roadmap-journeys.test.ts
├── actions-roadmap-placement.test.ts
├── actions-roster-import.test.ts
├── actions-save-publish-settings.test.ts
├── actions-save-rubric.test.ts
├── actions-save-template.test.ts
├── actions-student-announcements.test.ts
├── actions-student-booking.test.ts
├── actions-student-challenges.test.ts
├── actions-student-chat.test.ts
├── actions-student-discussions.test.ts
├── actions-student-docs.test.ts
├── actions-student-enrollment.test.ts
├── actions-student-grades.test.ts
├── actions-student-intel.test.ts
├── actions-student-invitations.test.ts
├── actions-student-projects-link-assignment.test.ts
├── actions-student-projects-team-idor.test.ts
├── actions-student-projects.test.ts
├── actions-student-quiz.test.ts
├── actions-submit-assessment.test.ts
├── actions-submit-assignment.test.ts
├── actions-submit-feedback.test.ts
├── actions-submit-verbal-deadline.test.ts
├── actions-super-admin-institutions.test.ts
├── actions-super-admin-team.test.ts
├── actions-update-assignment-meta.test.ts
├── adaptive-engine.test.ts
├── admin-page-inline-authz-guard.test.ts
├── ai-cost.test.ts
├── ai-grading-answer-key.test.ts
├── ai-grading-chunk.test.ts
├── ai-grading-grader.test.ts
├── ai-grading-hybrid-grader.test.ts
├── ai-grading-keywords.test.ts
├── ai-grading-manual-review.test.ts
├── ai-grading-mode-default.test.ts
├── ai-grading-references.test.ts
├── ai-grading-review-ordering.test.ts
├── ai-grading-signals.test.ts
├── ai-grading-similarity-grader.test.ts
├── ai-grading-suggest.test.ts
├── ai-tutor-prompt.test.ts
├── analytics-utils.test.ts
├── annotation-target.test.ts
├── announcement-auto-publish-notify.test.ts
├── announcement-form-schema.test.ts
├── announcement-notification-audience.test.ts
├── announcement-rich-content-empty.test.ts
├── announcements-stale-selection.test.tsx
├── assessment-timing.test.ts
├── asset-crop.test.ts
├── assignment-assistant-class-struggles.test.ts
├── assignment-assistant-prompts.test.ts
├── assignment-assistant-search-wiring.test.ts
├── assignment-assistant-tools.test.ts
├── assignment-attachment-validation.test.ts
├── assignment-deadline-gate.test.ts
├── assignment-document.test.ts
├── assignment-publish-state.test.ts
├── assignment-rubric-discard-draft.test.tsx
├── assignment-rubric.test.ts
├── assignments.test.ts
├── athena-about-adapter.test.ts
├── athena-about-route.test.ts
├── athena-answer-math-and-assets.test.tsx
├── athena-artifact-latex.test.tsx
├── athena-ask-line.test.tsx
├── athena-attach-promise-honesty.test.ts
├── athena-attachments.test.ts
├── athena-chat-directive.test.ts
├── athena-chat-quiz-lock.test.ts
├── athena-chat-run-streaming.test.ts
├── athena-citation-chips.test.tsx
├── athena-diff.test.ts
├── athena-directive.test.ts
├── athena-document-blocks.test.ts
├── athena-document-skipped-ops.test.ts
├── athena-knowledge-map-tool.test.ts
├── athena-message-attachments.test.ts
├── athena-models.test.ts
├── athena-notebook-adapter.test.ts
├── athena-panel-fill-chip.test.tsx
├── athena-prefill.test.ts
├── athena-quiz-adapter.test.ts
├── athena-rate-limit.test.ts
├── athena-run-card.test.ts
├── athena-shell-layers.test.tsx
├── athena-stalled-turn-detection.test.ts
├── athena-study-artifact-tool.test.ts
├── athena-tool-expansion.test.ts
├── athena-topic-mastery-context.test.ts
├── athena-verbal-adapter.test.ts
├── audio-devices.test.ts
├── auth-admin-context.test.ts
├── auth-callback-open-redirect.test.ts
├── auto-roadmap-assembly.test.ts
├── block-export.test.ts
├── block-reducer.test.ts
├── booking-note.test.ts
├── booking-reducer.test.ts
├── bulk-add-students-chunking.test.tsx
├── calendar-recurrence.test.ts
├── calendar-reducer.test.ts
├── calendar-validation.test.ts
├── certificate-linkedin.test.ts
├── challenge-match.test.ts
├── chart-data.test.ts
├── chat-route-empty-course.test.ts
├── citation.test.ts
├── class-question.test.ts
├── code-detection.test.ts
├── concept-boost.test.ts
├── concept-links.test.ts
├── content-change.test.ts
├── course-features.test.ts
├── coverage-signals-degraded.test.ts
├── datetime-local-roundtrip.test.ts
├── deck-converter.test.ts
├── delete-section-cascade-unknown.test.tsx
├── digest-sweep.test.ts
├── digest.test.ts
├── discussion-channel-name-validation.test.ts
├── discussions.test.ts
├── document-extraction.test.ts
├── document-parser-pdf.test.ts
├── document-parser-pptx.test.ts
├── document-slash-command.test.tsx
├── docx-native.test.ts
├── email-escape.test.ts
├── embeddings.test.ts
├── enqueue-job-inflight-dedup.test.ts
├── enqueue-mastery.test.ts
├── event-colors.test.ts
├── event-logger-activity-touch.test.ts
├── event-style-layout.test.ts
├── events-emit.test.ts
├── external-cost.test.ts
├── extraction-assets.test.ts
├── extraction-strip-nul.test.ts
├── feature-toggle-classify.test.ts
├── feed-actions.test.ts
├── feedbacks-admin-notes-grants.test.ts
├── fill-in-blank.test.ts
├── formula-insert.test.ts
├── frontier-mode-migration.test.ts
├── fullscreen-portal-container.test.tsx
├── grade-value.test.ts
├── grades-compute.test.ts
├── grades-student-drilldown.test.ts
├── hero-block-preview-fallback.test.tsx
├── ical-outlook.test.ts
├── image-content-hash.test.ts
├── image-vision.test.ts
├── infer-file-type.test.ts
├── intel-anonymous-author-redaction.test.ts
├── invite-redirects.test.ts
├── irt-estimator.test.ts
├── irt-grader.test.ts
├── jobs-kick-route.test.ts
├── jobs-worker.test.ts
├── journey-state.test.ts
├── knowledge-path.test.ts
├── lc-aggregates.test.ts
├── lc-anonymous-question-identity.test.ts
├── lc-cancel-scheduled-room.test.tsx
├── lc-class-insights-student.test.ts
├── lc-decks.test.ts
├── lc-insights-kick-resolution.test.ts
├── lc-insights-poll-resilience.test.tsx
├── lc-projector-open-signal.test.ts
├── lc-projector-text-strip.test.ts
├── lc-promote-deck-material.test.ts
├── lc-questions-snapshot-seed.test.ts
├── lc-quiz-reveal-entitlement.test.ts
├── lc-reaction-send-honesty.test.tsx
├── lc-render-deck-failed-rollback.test.ts
├── lc-render-deck.test.ts
├── lc-render-scheduled-deck-pipeline.test.ts
├── lc-report-qa-log-and-sort.test.ts
├── lc-report-student-sort.test.tsx
├── lc-schedule-occurrence-cap.test.ts
├── lc-scheduling.test.ts
├── lc-session-report.test.ts
├── lc-shuffle.test.ts
├── lc-summary-refusal-detection.test.ts
├── lc-upcoming-scheduled-rooms.test.ts
├── lecture-context.test.ts
├── library-queries.test.ts
├── live-classroom-quiz-review.test.ts
├── live-classroom-validation.test.ts
├── llm-inline-fill-in.test.ts
├── llm-quiz-dedup-types.test.ts
├── llm-quiz-metadata-clean.test.ts
├── llm-strip-asset-tags.test.ts
├── local-datetime.test.tsx
├── locator.test.ts
├── login-cwid-enumeration-oracle.test.ts
├── markdown-latex.test.tsx
├── markdown-math-delimiters.test.ts
├── marketplace-catalog.test.ts
├── material-event-authz.test.ts
├── module-dialogs-double-submit.test.tsx
├── module-item-display.test.ts
├── module-rows.test.ts
├── module-unlock.test.ts
├── module-url-classify.test.ts
├── node-check-deal-grade.test.ts
├── node-check-generate.test.ts
├── node-check-panel-first-load.test.tsx
├── notebook-model.test.ts
├── notebook-templates.test.ts
├── notebook.test.ts
├── notification-preferences.test.ts
├── numeric-input-commit.test.tsx
├── numeric-input-decimal.test.tsx
├── numeric-input-spinner.test.tsx
├── office-hours-expansion.test.ts
├── ooxml-robustness.test.ts
├── outcome-alignment-determinism.test.ts
├── outcome-alignment-levels.test.ts
├── outcome-alignment-map-codes.test.ts
├── outcome-alignment-reduce.test.ts
├── outcome-alignment-run.test.ts
├── outcome-alignment-summary-copy.test.ts
├── outcome-coverage.test.ts
├── override-schema.test.ts
├── paged-read.test.ts
├── pdf-tables-fixtures.test.ts
├── pdf-tables.test.ts
├── personal-event-schema.test.ts
├── pinecone-bill.test.ts
├── pinecone-embed.test.ts
├── pinecone-search.test.ts
├── pinecone-wrapper.test.ts
├── pptx-media-path-traversal.test.ts
├── pptx-native.test.ts
├── preclass-primer.test.ts
├── presence-flatten.test.ts
├── proctoring-summary.test.ts
├── professor-assistant-no-draft-quiz.test.ts
├── professor-assistant-student-resolve.test.ts
├── professor-invite-onboarding.test.ts
├── professor-todo-sources-failed.test.ts
├── professor-todos.test.ts
├── prototype-adapter.test.ts
├── provision-student.test.ts
├── publish-sweep.test.ts
├── question-complete.test.ts
├── question-display.test.tsx
├── quiz-active-attempt.test.ts
├── quiz-ai-persist-batch.test.ts
├── quiz-auto-publish-gate.test.ts
├── quiz-citation-batch.test.ts
├── quiz-concept-plan.test.ts
├── quiz-countdown-expire.test.tsx
├── quiz-countdown.test.ts
├── quiz-due-date-boundary.test.ts
├── quiz-generation-prompt.test.ts
├── quiz-max-attempts.test.ts
├── quiz-merge-questions.test.ts
├── quiz-phantom-visual-scrub.test.ts
├── quiz-player-answer-flush.test.tsx
├── quiz-player-reducer.test.ts
├── quiz-quality.test.ts
├── quiz-question-editor-attach.test.tsx
├── quiz-question-editor-single-correct.test.tsx
├── quiz-question-is-complete-write-path.test.ts
├── quiz-results-sweep.test.ts
├── quiz-reveal-gate.test.ts
├── quiz-review-ai-graded.test.tsx
├── quiz-review.test.ts
├── quiz-rubric-editor.test.tsx
├── quiz-source-citation.test.ts
├── quiz-studio-athena-fill.test.tsx
├── quiz-studio-back-flush.test.tsx
├── quiz-studio-reattach.test.tsx
├── quiz-studio-save-blocking.test.tsx
├── quiz-studio-sidebar.test.tsx
├── quiz-utils.test.ts
├── quiz-walkthrough-roundtrip.test.ts
├── quiz-wizard-type-gating.test.tsx
├── quiz-wizard-validation.test.ts
├── re-engagement-copy.test.ts
├── re-engagement-sweep.test.ts
├── reactions-tally.test.ts
├── read-only-event-block-clamp.test.tsx
├── recording-reconstruct.test.ts
├── regenerate-student-insights-pipeline.test.ts
├── render.test.ts
├── replay.test.ts
├── roadmap-activity-tallies.test.ts
├── roadmap-aggregates.test.ts
├── roadmap-annotation-richtext.test.ts
├── roadmap-class-insight.test.ts
├── roadmap-concept-refs.test.ts
├── roadmap-coverage-signals.test.ts
├── roadmap-coverage.test.ts
├── roadmap-dossier.test.ts
├── roadmap-lens-camera.test.ts
├── roadmap-mastery-journey-refs.test.ts
├── roadmap-mastery-overall.test.ts
├── roadmap-node-drawer.test.ts
├── roadmap-resource-nodes.test.ts
├── roadmap-signals.test.ts
├── roadmap-triage.test.ts
├── roster-import-parse.test.ts
├── same-page-link.test.ts
├── schema-announcement.test.ts
├── schema-calendar.test.ts
├── schema-challenge.test.ts
├── schema-course.test.ts
├── schema-department.test.ts
├── schema-direct-messages.test.ts
├── schema-enrollment.test.ts
├── schema-generate-live-quiz.test.ts
├── schema-grades.test.ts
├── schema-lc-class-insights.test.ts
├── schema-lc-interactions.test.ts
├── schema-misc.test.ts
├── schema-module.test.ts
├── schema-project-docs.test.ts
├── schema-project.test.ts
├── schema-quiz-question-id.test.ts
├── schema-quiz-scheduled-publish.test.ts
├── schema-quiz-zero-correct.test.ts
├── schema-section-staff.test.ts
├── schema-skill.test.ts
├── schema-student.test.ts
├── schema-studio-verbal.test.ts
├── scoring.test.ts
├── section-access.test.ts
├── security-auth-checks.test.ts
├── select-fullscreen-notice.test.ts
├── setup-spotlight-no-modules.test.tsx
├── setup.ts
├── signed-urls.test.ts
├── site-url.test.ts
├── skill-aggregate.test.ts
├── skill-extraction-parse.test.ts
├── skill-index-view.test.ts
├── skill-recompute.test.ts
├── skill-reconcile.test.ts
├── skill-scoring.test.ts
├── skill-tree.test.ts
├── skills-list-visibility.test.ts
├── slack-feedback.test.ts
├── snapshot-room-columns.test.ts
├── snapshot.test.ts
├── staff-directory-utils.test.ts
├── storage-paths.test.ts
├── streaming-blocks.test.ts
├── strip-quiz-answers.test.ts
├── student-assignment-unsaved-guard.test.tsx
├── student-calendar-events.test.ts
├── student-feature-gate-coverage.test.ts
├── student-modules-deeplink.test.tsx
├── student-modules-not-open-yet.test.tsx
├── student-profile-schema.test.ts
├── student-propose-tools.test.ts
├── student-status.test.ts
├── student-todos.test.ts
├── student-tool-contract.test.ts
├── student-tutor-tools.test.ts
├── studio-duplicate-marker.test.ts
├── studio-insert-ops.test.ts
├── studio-links.test.ts
├── studio-notebook-answer-key-strip.test.ts
├── studio-rubric-source.test.ts
├── study-focus.test.ts
├── submission-summary-sweep.test.ts
├── submissions-sort-filter.test.ts
├── team-meeting-hub.test.ts
├── transcript-extraction.test.ts
├── tutor-context.test.ts
├── tutor-rate-limit.test.ts
├── unified-result.test.ts
├── use-bake-watch.test.ts
├── use-drawings.test.tsx
├── use-interactions-opened-at.test.ts
├── use-module-expansion.test.ts
├── use-notes.test.tsx
├── use-room-channel.test.ts
├── use-sidebar-rail.test.ts
├── use-slide-sync.test.ts
├── verbal-assessment.test.ts
├── viewer-actions.test.ts
├── viewer-auth.test.ts
├── vision-figures.test.ts
├── vision-gate.test.ts
├── vision-retry.test.ts
├── vision-table-bbox-wiring.test.ts
├── vision-table-bbox.test.ts
├── warehouse-reducer.test.ts
├── webhook-resend.test.ts
├── worker-backfill-concepts.test.ts
├── worker-image-vision.test.ts
├── worker-supersede-guard.test.ts
├── xlsx-native.test.ts
├── youtube-verify.test.ts
└── zip.test.ts
```

</details>

### 📁 `supabase/` — 238 files

The database as code: `config.toml` (local stack: API 54321, DB 54322, Studio 54323, Inbucket 54324), 236 migrations, and `_snapshots/prod-schema.sql`. Migrations tell the feature history: hand-numbered `000000`-`000072` era, then timestamped clusters — Live Classroom v2 (36 files), assignments (16), roadmap (13), quizzes/IRT (20), Athena (8), skills/mastery, multi-tenancy hardening, and recurring RLS/security sweeps. **New migrations via `npx supabase migration new <name>` only** — never hand-numbered. ~137 tables total (see [5-architecture.md](./5-architecture.md) for the domain breakdown).

<details>
<summary>📂 Expand complete tree for <code>supabase/</code> (238 files)</summary>

```
supabase/
├── migrations/
│   ├── 00000000000000_base_schema.sql
│   ├── 00000000000001_enrollment_requests.sql
│   ├── 00000000000002_quiz.sql
│   ├── 00000000000003_proctoring.sql
│   ├── 00000000000004_video_proctoring.sql
│   ├── 00000000000005_adaptive_quiz.sql
│   ├── 00000000000006_announcements_v2.sql
│   ├── 00000000000007_classroom.sql
│   ├── 00000000000008_projects.sql
│   ├── 00000000000009_roadmap_progress.sql
│   ├── 00000000000010_remaining_features.sql
│   ├── 00000000000011_remaining_features_2.sql
│   ├── 00000000000012_secure_rpc_permissions.sql
│   ├── 00000000000013_quiz_late_submission.sql
│   ├── 00000000000014_quiz_timer_enforcement.sql
│   ├── 00000000000015_project_teams_grades_rls.sql
│   ├── 00000000000016_team_invitations.sql
│   ├── 00000000000017_rename_super_admin_role.sql
│   ├── 00000000000018_section_staff.sql
│   ├── 00000000000019_app_notifications.sql
│   ├── 00000000000020_project_tasks.sql
│   ├── 00000000000021_insert_project_phase_rpc.sql
│   ├── 00000000000022_drop_project_tasks.sql
│   ├── 00000000000023_phase_mentions.sql
│   ├── 00000000000024_doc_mentions.sql
│   ├── 00000000000025_chat_attachments_bucket.sql
│   ├── 00000000000026_project_allow_team_workspace.sql
│   ├── 00000000000027_direct_messages.sql
│   ├── 00000000000028_message_soft_delete.sql
│   ├── 00000000000029_extraction_jobs.sql
│   ├── 00000000000030_live_classroom_m1.sql
│   ├── 00000000000031_classroom_replica_identity_full.sql
│   ├── 00000000000032_enrollments_select_policies.sql
│   ├── 00000000000033_course_sections_select_policies.sql
│   ├── 00000000000033b_classroom_rls_fix_recursion.sql
│   ├── 00000000000034_lc_events_and_broadcast.sql
│   ├── 00000000000035_lc_rooms_drop_realtime_publication.sql
│   ├── 00000000000036_lc_interactions.sql
│   ├── 00000000000037_lc_drawings.sql
│   ├── 00000000000037b_lc_drawings_drop_old_overload.sql
│   ├── 00000000000038_lc_drawings_rate_limit.sql
│   ├── 00000000000039_lc_slide_annotations.sql
│   ├── 00000000000040_lc_rooms_auto_end.sql
│   ├── 00000000000041_lc_room_lifecycle_events.sql
│   ├── 00000000000042_lc_deck_render_events.sql
│   ├── 00000000000043_lc_decks_storage_cleanup.sql
│   ├── 00000000000044_institutions_phase1.sql
│   ├── 00000000000045_institutions_phase2_hardening.sql
│   ├── 00000000000046_feedbacks_tenant_isolation.sql
│   ├── 00000000000047_storage_lockdown_phase1.sql
│   ├── 00000000000048_storage_lockdown_phase2_course_materials.sql
│   ├── 00000000000049_storage_lockdown_phase3a_live_classroom_decks.sql
│   ├── 00000000000050_platform_owner.sql
│   ├── 00000000000051_drop_legacy_storage_policies.sql
│   ├── 00000000000052_tenant_scope_is_admin_rls.sql
│   ├── 00000000000053_super_admin_nullable_institution.sql
│   ├── 00000000000054_lc_auto_end_storage_safe.sql
│   ├── 00000000000055_tenant_consistency_guards.sql
│   ├── 00000000000056_section_professor_tenant_match.sql
│   ├── 00000000000057_handle_new_user_noop.sql
│   ├── 00000000000058_app_notifications_message_id_index.sql
│   ├── 00000000000059_lc_decks_bucket_size.sql
│   ├── 00000000000060_lc_rooms_module_item_ref.sql
│   ├── 00000000000061_lc_transcriptions.sql
│   ├── 00000000000062_lc_revoke_rpc_execute.sql
│   ├── 00000000000063_lc_atomic_upvote.sql
│   ├── 00000000000064_roadmap_manual_editor.sql
│   ├── 00000000000065_roadmap_manual_hierarchy.sql
│   ├── 00000000000066_roadmap_edges_endpoint_types.sql
│   ├── 00000000000067_project_docs.sql
│   ├── 00000000000068_reconcile_prod_drift.sql
│   ├── 00000000000069_enable_rls_core_academic_tables.sql
│   ├── 00000000000070_reconcile_prod_schema_drift.sql
│   ├── 00000000000071_standardize_timestamptz.sql
│   ├── 00000000000072_lc_decks_allow_office_mime.sql
│   ├── 20260609000100_quizzes_v2_irt.sql
│   ├── 20260609000200_quiz_walkthrough_transcript.sql
│   ├── 20260609000300_quiz_question_source_citation.sql
│   ├── 20260610051747_lc_interactions_sanitize_broadcast.sql
│   ├── 20260610055939_lc_presence_topic_rls.sql
│   ├── 20260611204904_harden_profiles_self_update.sql
│   ├── 20260611220312_scope_blocked_times_and_reaction_rls.sql
│   ├── 20260612044754_lc_session_reports.sql
│   ├── 20260612060000_quiz_answers_rationale.sql
│   ├── 20260612141203_quiz_uploads_module_unique.sql
│   ├── 20260614051501_lc_decks_multi.sql
│   ├── 20260615013146_lc_class_insights.sql
│   ├── 20260616065923_ai_usage_events.sql
│   ├── 20260616232126_athena_chat_persistence.sql
│   ├── 20260617024531_assignments.sql
│   ├── 20260617044419_assignment_refinements.sql
│   ├── 20260617050624_assignment_submissions_bucket.sql
│   ├── 20260618120000_athena_attachments_bucket.sql
│   ├── 20260619133927_assignment_studio_v2.sql
│   ├── 20260619143157_roadmap_progress_checkoff_rpc.sql
│   ├── 20260620212822_secure_audit_log_with_actor_view.sql
│   ├── 20260624130647_athena_rate_limits.sql
│   ├── 20260624135948_harden_athena_rate_limit_rpc_grants.sql
│   ├── 20260624194443_topic_mastery_topics.sql
│   ├── 20260624202553_lc_notes.sql
│   ├── 20260625162916_topic_mastery_mapping_and_scores.sql
│   ├── 20260626184930_security_audit_remediation.sql
│   ├── 20260628225520_fix_course_materials_safe_uuid_cast.sql
│   ├── 20260629120000_topic_mastery_excluded_flag.sql
│   ├── 20260629130000_extraction_jobs_recompute_mastery_kind.sql
│   ├── 20260630174550_topic_mastery_atomic_writes.sql
│   ├── 20260630205346_lc_room_setup_config.sql
│   ├── 20260630215531_topics_realtime_publication.sql
│   ├── 20260701000000_assignment_publish_notified_at.sql
│   ├── 20260701010000_assignment_exact_time_publish.sql
│   ├── 20260701034022_link_assignment_to_project_phase.sql
│   ├── 20260701071210_fix_project_members_rls_recursion.sql
│   ├── 20260701071211_add_phase_comments.sql
│   ├── 20260701071321_scrub_deleted_chat_message_content.sql
│   ├── 20260701152540_background_jobs.sql
│   ├── 20260701161247_outcome_alignment_schema.sql
│   ├── 20260701161847_background_jobs_progress_append.sql
│   ├── 20260701163235_persist_outcome_alignment.sql
│   ├── 20260702000000_shared_feed_items.sql
│   ├── 20260702054000_persist_outcome_alignment_uuid_guard.sql
│   ├── 20260702142225_preclass_primers.sql
│   ├── 20260702142230_preclass_audio_bucket.sql
│   ├── 20260702160000_feed_items_full_unique_index.sql
│   ├── 20260702171811_course_materials_allow_audio_mime.sql
│   ├── 20260702185051_assignment_cell_images_bucket.sql
│   ├── 20260703171852_lc_recordings.sql
│   ├── 20260704160006_primers_default_on.sql
│   ├── 20260706172347_add_outcome_alignment_map_cache.sql
│   ├── 20260707011157_topic_mastery_330_security_hardening.sql
│   ├── 20260707120000_roadmap_edges_resource_endpoints.sql
│   ├── 20260707130000_rename_topics_to_skills.sql
│   ├── 20260707210000_pulse_email_digest.sql
│   ├── 20260707214038_announcements_importance_ack_multisection.sql
│   ├── 20260708120000_lc_rooms_scheduling.sql
│   ├── 20260708120100_activity_skills_live_quiz_type.sql
│   ├── 20260708120200_lc_interactions_skillids_payload_rename.sql
│   ├── 20260708120300_drop_legacy_classroom_v1.sql
│   ├── 20260708130000_skills_suppressed_flag.sql
│   ├── 20260709081357_saved_templates.sql
│   ├── 20260709174739_pulse_reengagement.sql
│   ├── 20260709193444_cost_analysis_ledgers.sql
│   ├── 20260709223304_cost_analysis_hardening.sql
│   ├── 20260710194202_roadmap_notes.sql
│   ├── 20260710222117_content_embeddings.sql
│   ├── 20260711191232_roadmap_canvas_band_order.sql
│   ├── 20260711201500_roadmap_note_kind.sql
│   ├── 20260713120000_roadmap_node_pinned_page.sql
│   ├── 20260713151153_announcements_storage_rls.sql
│   ├── 20260713172950_lc_scheduled_rooms.sql
│   ├── 20260714032231_lc_rooms_drop_legacy_scheduled_cols.sql
│   ├── 20260714155742_assignment_regrades_and_comments.sql
│   ├── 20260714165619_lc_scheduled_room_started_broadcast.sql
│   ├── 20260714173221_roadmap_placement_atomic_upsert.sql
│   ├── 20260714175520_lc_room_ended_section_broadcast.sql
│   ├── 20260714201003_assignments_default_on.sql
│   ├── 20260715035123_quiz_questions_is_complete.sql
│   ├── 20260715191137_security_audit_rpc_hardening_jul15.sql
│   ├── 20260716004112_add_quiz_generation_notice.sql
│   ├── 20260716015359_add_quiz_generation_started_at.sql
│   ├── 20260716115237_assignment_assessment_proctoring.sql
│   ├── 20260716120000_quiz_publish_notified_at.sql
│   ├── 20260716164010_add_quiz_generation_total.sql
│   ├── 20260716174700_atomic_set_quiz_question_assignments.sql
│   ├── 20260717005246_lc_room_blank_screen.sql
│   ├── 20260717060430_rpc_grant_hardening_repair.sql
│   ├── 20260717182401_add_resubmit_until.sql
│   ├── 20260717192822_activity_skills_challenge_type.sql
│   ├── 20260717193923_challenge_certificates.sql
│   ├── 20260717194352_weighted_gradebook_scheme.sql
│   ├── 20260718120000_bookings_realtime.sql
│   ├── 20260718130000_calendar_qa_hardening.sql
│   ├── 20260718140000_office_hours_hybrid_mode.sql
│   ├── 20260719120000_bookings_client_read_only.sql
│   ├── 20260720120000_submission_summary_logs.sql
│   ├── 20260720161737_material_vector_chunks.sql
│   ├── 20260720161738_background_jobs_subject_key.sql
│   ├── 20260720172906_extraction_jobs_backfill_concepts_kind.sql
│   ├── 20260720174305_classroom_uploads_module_unique.sql
│   ├── 20260721100000_late_request_rubric_comments.sql
│   ├── 20260721100001_remove_auto_zero.sql
│   ├── 20260722195346_add_assignment_grade_institution_indexes.sql
│   ├── 20260723012146_assignment_ai_grade_suggestions.sql
│   ├── 20260723200514_team_meetings.sql
│   ├── 20260724004511_quiz_item_stats.sql
│   ├── 20260724011154_skill_mastery_snapshots_and_events_index.sql
│   ├── 20260725010526_roadmap_coverage_lifecycle.sql
│   ├── 20260725013439_graded_with_rubric_marker.sql
│   ├── 20260725024723_node_checks.sql
│   ├── 20260727144045_lc_interactions_hide_unclosed_quiz_answers.sql
│   ├── 20260727153030_module_dividers.sql
│   ├── 20260727175143_retire_old_roadmap.sql
│   ├── 20260728120000_add_calendar_event_types.sql
│   ├── 20260728130000_blocked_times_recurrence.sql
│   ├── 20260728140000_blocked_times_busy_times_rpc.sql
│   ├── 20260728150000_blocked_times_course_and_mode.sql
│   ├── 20260728160000_notification_soft_delete.sql
│   ├── 20260728221850_frontier_mode.sql
│   ├── 20260729042524_restrict_node_check_pool_to_tas.sql
│   ├── 20260729044216_module_system_kind.sql
│   ├── 20260729120000_merge_assignment_settings_rpc.sql
│   ├── 20260731171110_student_insight_summaries.sql
│   ├── 20260731180233_profiles_last_active_at.sql
│   ├── 20260802174306_athena_rate_limit_scope.sql
│   ├── 20260803120000_avatars_bucket.sql
│   ├── 20260803130000_app_notifications_readonly_rls.sql
│   ├── 20260803140000_student_personal_events.sql
│   ├── 20260803150000_personal_events_recurrence.sql
│   ├── 20260803163000_delete_office_hours_if_unbooked.sql
│   ├── 20260803175352_class_insight_summaries.sql
│   ├── 20260803231843_discussion_channels_unique_default.sql
│   ├── 20260804154308_athena_artifacts.sql
│   ├── 20260804161043_reconcile_reverse_drift_prod.sql
│   ├── 20260805150929_ai_tutor_rate_limit_scope.sql
│   ├── 20260805170049_athena_artifact_archive.sql
│   ├── 20260805193945_quizzes_max_attempts_no_cap.sql
│   ├── 20260805195812_lc_transcript_insights.sql
│   ├── 20260806153145_security_audit_close_cross_tenant_gaps.sql
│   ├── 20260807153351_auth_rate_limits_and_extraction_job_tenancy.sql
│   ├── 20260807172505_admin_roster_import.sql
│   ├── 20260808033043_guard_scheduled_quiz_publish_on_questions.sql
│   ├── 20260810202604_assignment_answer_keys.sql
│   ├── 20260810202904_widen_module_item_type_image.sql
│   ├── 20260810205704_feedbacks_admin_notes_column_grants.sql
│   ├── 20260810210855_align_enrollment_status_check.sql
│   ├── 20260811103812_ai_grade_suggestion_version_guard.sql
│   ├── 20260811141254_lock_rubric_source_reads_to_staff.sql
│   ├── 20260811141311_answer_key_rubric_ai.sql
│   ├── 20260811151113_ai_suggestion_rpc_derive_tenant.sql
│   ├── 20260814180450_widen_background_jobs_dedup_to_running.sql
│   ├── 20260814214327_always_broadcast_poll_aggregate.sql
│   ├── 20260814215939_rename_lc_toggle_upvote_to_add.sql
│   ├── 20260817013817_announcement_reads_track_bulk.sql
│   ├── 20260817195713_join_project_team_atomic.sql
│   ├── 20260817214138_athena_about_rate_limit_scope.sql
│   ├── 20260818013038_discussion_channels_replica_identity_full.sql
│   └── 20260818013200_sanitize_question_broadcast.sql
├── .gitignore
└── config.toml
```

</details>

### 📁 `docs/` — 88 files

Team documentation. `briefs/` (13 feature briefs — historical; the brief workflow was retired 2026-08), `designs/` (40 system designs incl. `system-design-rules.md` — the standard every design follows), `onboarding/` (this guide), `compliance/` (HECVAT for Stevens), `e2e-qa-session/` (the 29-surface QA sweep), `handoff/` (notifications+calendar engineer handoff), `jobs/` (intern hiring packets), `research/`, plus `decisions.md` (frozen Feb 2026 — historical), `user-signals.md` (the evidence behind CLAUDE.md's design priorities), and `athena/analysis.md` (cost per Athena query).

<details>
<summary>📂 Expand complete tree for <code>docs/</code> (88 files)</summary>

```
docs/
├── athena/
│   └── analysis.md
├── briefs/
│   ├── ai-assisted-grading/
│   │   └── brief.md
│   ├── ai-tutor-rag/
│   │   └── brief.md
│   ├── assignment-studio/
│   │   ├── brief.md
│   │   ├── template-studio.md
│   │   ├── v2.md
│   │   └── wave2.md
│   ├── athena/
│   │   └── brief.md
│   ├── audit-log-rls-fix/
│   │   └── brief.md
│   ├── challenges/
│   │   └── brief.md
│   ├── cost-analysis/
│   │   └── brief.md
│   ├── live-classroom-presenter-view/
│   │   └── brief.md
│   ├── professor-notifications/
│   │   └── brief.md
│   ├── quiz-analytics-unification/
│   │   └── brief.md
│   ├── scholera-pulse/
│   │   └── brief.md
│   ├── student-dashboard/
│   │   └── brief.md
│   └── topic-mastery/
│       └── brief.md
├── designs/
│   ├── athena/
│   │   ├── athena-chat-persistence-design.md
│   │   ├── athena-personas.md
│   │   ├── athena-system-design.md
│   │   └── athena-tools-expansion.md
│   ├── live-classroom/
│   │   ├── live-classroom-class-insights-design.md
│   │   ├── live-classroom-class-insights-plan.md
│   │   ├── live-classroom-data-model-unification.md
│   │   ├── live-classroom-multi-deck.md
│   │   ├── live-classroom-quiz-history.md
│   │   ├── live-classroom-report-templates.md
│   │   └── live-classroom-session-report.md
│   ├── quiz-analytics-screenshots/
│   │   ├── 01-student-quiz-list.png
│   │   ├── 02-student-ADAPTIVE-results.png
│   │   ├── 03-student-STANDARD-results.png
│   │   ├── 04-professor-quiz-list.png
│   │   ├── 05-professor-ADAPTIVE-insights-overview.png
│   │   ├── 06-professor-ADAPTIVE-insights-submissions.png
│   │   ├── 07-professor-ADAPTIVE-student-detail.png
│   │   ├── 08-professor-STANDARD-insights-overview.png
│   │   ├── 09-professor-STANDARD-student-detail.png
│   │   └── README.md
│   ├── quizzes/
│   │   ├── athena-quiz-authoring.md
│   │   ├── ccat-system-design.md
│   │   └── hybrid-extraction-and-citation.md
│   ├── admin-roster-import.md
│   ├── ai-assisted-grading.md
│   ├── assignment-assessment-proctoring.md
│   ├── assignment-grading-tweaks.md
│   ├── assignment-regrade-and-per-question-feedback.md
│   ├── assignment-skill-tagging.md
│   ├── assignment-studio-consolidated.md
│   ├── athena-ask-line.md
│   ├── athena-students.md
│   ├── blank-template-notion-redesign.md
│   ├── document-studio-ux-v2.md
│   ├── frontier-mode.md
│   ├── live-classroom-presenter-view.md
│   ├── live-classroom-v1-scoping.md
│   ├── module-embedding-pinecone-system-design.md
│   ├── modules-surface-redesign.md
│   ├── pdf-export-service.md
│   ├── professor-calendar-office-hours.md
│   ├── quiz-analytics-unification.md
│   ├── quiz-editor-studio.md
│   ├── quiz-generation-v2.md
│   ├── roadmap-179-v2-journeys-v11-nodes.md
│   ├── roadmap-all-resources.md
│   ├── roadmap-engine.md
│   ├── scholera-pulse-and-calendar-handoff.md
│   ├── scholera-pulse-notifications.md
│   ├── shared-event-layer.md
│   ├── student-assignments-redesign.md
│   ├── student-calendar.md
│   ├── student-dashboard-part1-todo.md
│   ├── student-dashboard-part2-mini-calendar.md
│   ├── student-personal-calendar-events.md
│   ├── system-design-rules.md
│   ├── topic-mastery.md
│   ├── verbal-assessment-student-flow.md
│   └── weighted-gradebook.md
├── handoff/
│   ├── 01-system-diagram.md
│   ├── 02-architecture.md
│   └── 03-testing-and-notes.md
├── onboarding/
│   └── guide/                        # this guide (README + 7 numbered files)
├── ai-grading-eval-reports.md
├── assignments-workflow.md
├── competitor-analysis.md
├── cost_analysis.md
├── decisions.md
├── pilot-feedback-tracker.md
├── schema.sql
└── user-signals.md
```

</details>

### 📁 `e2e/` — 24 files

Playwright end-to-end tests, chromium-only, against a local dev server + local Supabase (`.env.test`). `tests/` holds 7 P0 specs (auth round-trip, admin-invites-professor, quiz lifecycle, module consumption, live-classroom sync, fullscreen banner, todo emit). `setup/global-setup.ts` seeds + persists per-role auth state; `visual/` is the markdown-walkthrough practice driven live via the Chrome DevTools MCP; `load/` is the (scaffold) 100-student realtime load test with the Supabase msg/s math.

<details>
<summary>📂 Expand complete tree for <code>e2e/</code> (24 files)</summary>

```
e2e/
├── fixtures/
│   └── test-users.ts
├── helpers/
│   ├── auth.ts
│   ├── db.ts
│   ├── invites.ts
│   └── testids.ts
├── load/
│   ├── classroom-100-students.k6.ts
│   └── load-README.md
├── setup/
│   └── broadcast-smoke.ts
├── tests/
│   ├── admin-invites-professor.spec.ts
│   ├── auth.spec.ts
│   ├── live-classroom-fullscreen-banner.spec.ts
│   ├── live-classroom-m1-sync.spec.ts
│   ├── quiz-lifecycle.spec.ts
│   ├── student-module-consumption.spec.ts
│   └── student-todo-emit.spec.ts
├── visual/
│   ├── announcements-reading-pane.md
│   ├── assignment-studio-v2.md
│   ├── ccat-adaptive-quiz.md
│   ├── extraction-and-citation.md
│   ├── quiz-editor-studio.md
│   └── README.md
├── global-setup.ts
├── playwright.config.ts
└── playwright.todos.config.ts
```

</details>

### 📁 `infra/` — 8 files

Cloud deployment only (local setup lives in `scripts/`). `app/deploy-to-prod.sh` (main + clean tree + lint/typecheck enforced; build via Cloud Build, deploy as the human's own gcloud identity), `deploy-to-staging.sh` (isolated Supabase project, secrets via Secret Manager, hard-refuses the prod ref), `setup-sweep-schedulers.sh` (Cloud Scheduler jobs that drain the background/extraction queues every 5 min), and `microservices/deck-converter/` (Gotenberg PPTX→PDF, `--concurrency=1` required).

<details>
<summary>📂 Expand complete tree for <code>infra/</code> (8 files)</summary>

```
infra/
├── app/
│   ├── cloudbuild.staging.yaml
│   ├── cloudbuild.yaml
│   ├── deploy-to-prod.sh
│   ├── deploy-to-staging.sh
│   └── setup-sweep-schedulers.sh
├── microservices/
│   └── deck-converter/
│       ├── deploy.sh
│       └── README.md
└── README.md
```

</details>

### 📁 `scripts/` — 26 files

Operational scripts. `dev-setup/` is the newcomer path (`setup-local.sh` + `seed-dev.ts`, hard-gated to localhost). Root: extraction backfills (dry-run by default), Pinecone index creation + namespace whois, `seed-e2e.ts`, live-room list/end tools, and prod backups. `archive/` holds retired one-offs (the SkillSignal migration set, Elo test harnesses) kept for audit trail.

<details>
<summary>📂 Expand complete tree for <code>scripts/</code> (26 files)</summary>

```
scripts/
├── archive/
│   ├── apply-mig-59-bucket-size.ts
│   ├── migrate-planning-to-docs.ts
│   ├── migrate-ss-data.ts
│   ├── migrate-ss-phase0.ts
│   ├── migrate-ss-shared.ts
│   ├── README.md
│   ├── remap-professor.ts
│   ├── send-invites.ts
│   ├── test-adaptive-engine.ts
│   ├── test-adaptive-integration.ts
│   ├── test-adaptive-validations.ts
│   └── validate-migration.ts
├── dev-setup/
│   ├── CONTEXT.md
│   ├── pulse-immediate-publish-kick.sql
│   ├── pulse-local-cron.sql
│   ├── pulse-local-sweep.sh
│   ├── seed-dev.ts
│   └── setup-local.sh
├── backfill-concepts.ts
├── backfill-extraction.ts
├── end-live-rooms.ts
├── list-live-rooms.ts
├── pinecone-create-materials-index.ts
├── pinecone-whois-namespace.ts
├── seed-dev-students.ts
└── seed-e2e.ts
```

</details>

### 📁 `public/` — 20 files

Static assets: brand logos, `landing/` (real product screenshots — per PRODUCT.md, "the product is the demo"), `models/face-api/` (browser-side proctoring weights), `studio-samples/` (SVG diagram samples), `worklets/pcm-processor.js` (AudioWorklet for live transcription capture).

<details>
<summary>📂 Expand complete tree for <code>public/</code> (20 files)</summary>

```
public/
├── landing/
│   ├── ai-tutor.png
│   ├── hero-film-poster.jpg
│   ├── live-classroom.png
│   ├── professor-dashboard.png
│   ├── quizzes.png
│   ├── roadmap.png
│   └── student-dashboard.png
├── models/
│   └── face-api/
│       ├── tiny_face_detector_model-weights_manifest.json
│       └── tiny_face_detector_model.bin
├── studio-samples/
│   ├── bar-chart.svg
│   ├── flowchart.svg
│   ├── histogram.svg
│   ├── line-chart.svg
│   ├── neural-network.svg
│   └── scatter-plot.svg
├── template-previews/
│   └── README.md
├── worklets/
│   └── pcm-processor.js
├── course-banner-default.jpg
├── logo-mark.png
└── logo.png
```

</details>

### 📁 `.github/` — 5 files

CI + workflow automation: `ci.yml` (lint → typecheck → build → test on every push/PR to main), `mastery-recompute-nightly.yml` (2 AM skill-mastery sweep), and manual-dispatch fallbacks for the jobs/extraction sweeps (the 5-min cadence moved to Cloud Scheduler after an Actions-billing outage silently stopped every workflow).

<details>
<summary>📂 Expand complete tree for <code>.github/</code> (5 files)</summary>

```
.github/
├── workflows/
│   ├── ci.yml
│   ├── extraction-sweep.yml
│   ├── jobs-sweep.yml
│   └── mastery-recompute-nightly.yml
└── dependabot.yml
```

</details>

### 📁 `.claude/` — 12 files

Claude Code configuration checked into the repo: review-gate agents (`security-reviewer`, `test-reviewer`, `ux-reviewer`), and `rules/` — path-scoped rule files (security checklists for server actions/client/migrations, `data-access.md`, `vector-db.md`, `ui-design.md`, `dead-ends.md`) that auto-load when the files they govern are edited.

<details>
<summary>📂 Expand complete tree for <code>.claude/</code> (12 files)</summary>

```
.claude/
├── agents/
│   ├── security-reviewer.md
│   ├── test-reviewer.md
│   └── ux-reviewer.md
├── rules/
│   ├── athena-cost.md
│   ├── data-access.md
│   ├── dead-ends.md
│   ├── security-client.md
│   ├── security-migrations.md
│   ├── security-server-actions.md
│   ├── ui-design.md
│   └── vector-db.md
└── skills/
    └── mermaid/
        └── SKILL.md
```

</details>

## 💡 Key Insights

- **The professor tree dwarfs everything else** — `src/components/professor/` (315 files) + the professor route tree carry most of the product surface; the student side mirrors it read-only.
- **Logic lives in `src/lib/`, not in components** — the realtime classroom, grading engines, and AI plumbing are hook/function layers; components are mostly thin `'use client'` shells.
- **Migrations are the schema's single source of truth** — `git pull` + `supabase db reset` reproduces prod's schema exactly; there is no maintained snapshot to drift.
- **Tests mirror the action layer** — 71 `actions-*` test files map one-to-one onto server-action surfaces; when you add an action file, a matching test file is the norm.
- **Config files carry the design record** — deploy scripts, `next.config.ts`, and workflows all open with "why it is this way" comments that are more current than `docs/archive/decisions.md`.

## 📚 Next Steps

- **What do these pieces do?** → [5-architecture.md](./5-architecture.md)
- **Deep dive on the critical files** → [6-file-insights.md](./6-file-insights.md)
- **Get it running** → [2-quick-start.md](./2-quick-start.md)
