# Scholera - AI-Native Learning Management System

## What is Scholera?

Scholera is an AI-native LMS built to replace Canvas. Unlike Canvas (built 2011) which bolts AI onto old architecture, Scholera is built with AI as the foundation.

**Target Users:**
- Stevens Institute of Technology (initial pilot)
- Later: Other NJ universities

**Core Differentiators:**
- AI course generation (5 min vs 40 hours)
- AI tutor trained on specific course materials
- Adaptive quizzes that adjust to student level
- Predictive analytics (who will fail, what to do)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16, TypeScript, Tailwind CSS, shadcn/ui |
| Backend | Supabase (Postgres + Auth + Storage + Realtime) |
| AI | Claude API (planned), pgvector for RAG |
| Hosting | TBD (Vercel for frontend, Supabase for backend) |

---

## Project Structure
```
scholera-web/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── (auth)/             # Login, Signup pages
│   │   ├── (dashboard)/        # Protected dashboard pages
│   │   └── page.tsx            # Landing page
│   ├── components/
│   │   └── ui/                 # shadcn components
│   └── lib/
│       └── supabase/           # Supabase client (client.ts, server.ts)
├── .env.local                  # Environment variables
└── middleware.ts               # Auth middleware
```

---

## Current Status

### ✅ Completed
- [x] Supabase project created (scholera-prod)
- [x] Database schema created (foundation tables)
- [x] Next.js app initialized with TypeScript + Tailwind
- [x] Supabase client configured (client + server)
- [x] Auth middleware set up
- [x] Login page working
- [x] Signup page working
- [x] Auto-create profile on signup (trigger)
- [x] Basic dashboard page (shows user email + role)

### 🔄 In Progress
- [ ] GitHub integration for projects (OAuth, webhooks, commit tracking — schema ready)
- [ ] AI features (tutor, quiz generation, adaptive learning)

### ✅ Also Completed (since initial CONTEXT)
- [x] Admin: Manage departments, professors, courses, programs, students
- [x] Professor: Course management (about, announcements, modules, quizzes, grades, read-only roster, roadmap, projects, calendar)
- [x] Student: Courses (admin-enrolled — the catalog/self-enrollment flow was removed 2026-08; see docs/designs/platform/admin-roster-import.md), profile, office hours, grades, quizzes, projects
- [x] Admin: Bulk roster import (paste name/email/course rows → preview → chunked import; creates accounts inline) + institution self-unenroll policy window
- [x] Quiz system — fully Supabase-backed (5 tables: quiz_questions, quizzes, quiz_question_assignments, quiz_attempts, quiz_answers)
  - Server-side grading, auto-save, negative marking, bonus/extra credit, formula sheet upload, leaderboard
  - Professor: question bank CRUD, quiz editor with settings, preview, insights
  - Student: attempt flow with timer, flagging, confidence, formula sheet panel, results with leaderboard
- [x] Knowledge Warehouse / My Library (material upload, organization, search)
- [x] Course roadmap (visual node graph — one canvas for both roles; status derived from coverage)
- [x] Calendar & Office Hours booking
- [x] Collaborative Project Workspace (teams, phases, videos, showcase)
- [x] Per-page visual customization system (themes, glass toolbar, student preview)
- [x] Announcements v2: Rich text editor (TipTap/Novel), scheduled publishing, read tracking, emoji reactions, comments, @-mentions with mentioned-only visibility
- [x] Live Classroom Mode: real-time sessions with polls, quizzes, Q&A (Supabase Realtime)
- [x] AI-assisted assignment grading with a calibration flywheel: the AI drafts per-criterion grades with verbatim evidence quotes; the professor reviews evidence-first (high-stakes criteria hide the AI verdict until the professor decides), every override is captured in `assignment_grading_corrections`, committed grades feed back into later drafts as few-shot examples, and the grader shows a running "AI matched your decisions on X of Y criteria" line

---

## User Roles

| Role | Email Pattern | Access |
|------|---------------|--------|
| institution_admin | Manually assigned | Everything within one university/tenant |
| professor | @stevens.edu (not student) | Own courses |
| student | @student.stevens.edu or default | Enrolled courses |

**Note:** Role detection via email is set up in database trigger but may need refinement. Currently defaults to 'student'.

---

## Environment Variables
```
NEXT_PUBLIC_SUPABASE_URL=https://ywdqaoahfmmzcsczxvxn.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...(truncated)
```

---

## Key Decisions Made

1. **SQL over NoSQL** — LMS has complex relationships. PostgreSQL handles this better.
2. **Supabase** — Gives us Auth, DB, Storage, Realtime in one platform.
3. **Course Sections** — Separated "Course" (CS 556) from "Section" (CS 556-A Spring 2026) for flexibility.
4. **Department Faculty Table** — Professors are assigned to departments with position, contact, etc.
5. **Events Table** — Track everything for analytics later.
6. **pgvector** — Will use for RAG embeddings, same database.

---

## How to Run
```bash
cd scholera-web
npm run dev
# Open http://localhost:3000
```

---

## Testing Accounts

Create via /signup:
- Use any @stevens.edu email for professor
- Use any other email for student
- Manually update `profiles.role` in Supabase to 'institution_admin' for admin access

---

## Last Updated
February 22, 2026