# Dashboard Feature Context

## What This Does
Protected area for authenticated users. Route group `(dashboard)` wraps all post-login pages with a shared layout (header, navigation, dev tools). Content is role-aware: institution_admin, professor, and student each see different dashboards with role-specific metrics.

## Files

| File | Type | Purpose |
|------|------|---------|
| `layout.tsx` | Server Component | Shared layout: fetches profile, renders header + sidebar |
| `error.tsx` | Client Component | Error boundary: catches dashboard errors, shows recovery UI |
| `dashboard/page.tsx` | Server Component | Main dashboard with role-specific metric cards |
| `dashboard/actions.ts` | Server Actions | `signOut()` |
| `admin/layout.tsx` | Server Component | Admin role guard — blocks non-institution_admin users |
| `admin/departments/page.tsx` | Server Component | Department list page with searchable table |
| `admin/departments/loading.tsx` | Server Component | Loading skeleton for department list |
| `admin/departments/actions.ts` | Server Actions | CRUD: create, update, delete department + cascade counts |
| `admin/departments/[departmentId]/page.tsx` | Server Component | Department detail/edit page with tabs |
| `admin/departments/[departmentId]/loading.tsx` | Server Component | Loading skeleton for department detail |
| `admin/departments/[departmentId]/not-found.tsx` | Server Component | Not found page for invalid department IDs |
| `admin/departments/course-actions.ts` | Server Actions | CRUD: create, update, delete course + cascade counts |

## Database Tables Touched
- `profiles` — fetched in layout.tsx to get user role, name, avatar
- `departments` — counted for admin dashboard metrics
- `courses` / `course_sections` — counted for professor dashboard metrics
- `enrollments` — counted for both professor and student dashboard metrics
- `events` — (planned) will log page views and user actions
- `assignments` / `assignment_submissions` — Assignment Studio (see section below)

## Component Relationships
```
(dashboard)/layout.tsx
  -> Sidebar (client, role-aware navigation, hidden on mobile)
  -> DashboardHeader (client, receives profile prop)
     -> hamburger Menu button (lg:hidden, opens SidebarMobile)
     -> SidebarMobile (client, Sheet drawer for mobile)
     -> signOut() server action
  -> {children} =
     dashboard/page.tsx → DashboardCard (local, display only)
     admin/layout.tsx (role guard) →
       admin/departments/page.tsx → DepartmentCardGrid (client, interactive)
         -> CreateDepartmentDialog → DepartmentForm
         -> DeleteDepartmentDialog
       admin/departments/[departmentId]/page.tsx → DepartmentForm (edit mode)
         -> CourseTable (client, interactive CRUD)
           -> CourseDialog → CourseForm (create mode, no `course` prop)
           -> CourseDialog → CourseForm (edit mode, row menu → Edit)
           -> DeleteCourseDialog (with cascade warning)
```

## Data Flow
1. `layout.tsx` (server) creates Supabase client, fetches `auth.getUser()` + `profiles` row
2. Passes `profile` to `DashboardHeader` as props
3. Passes `profile.role` to `Sidebar` for role-aware navigation
4. `dashboard/page.tsx` (server) independently fetches user + profile + role-specific counts
5. Role-specific queries defined in `src/lib/supabase/queries.ts`
6. Admin pages pass through `admin/layout.tsx` role guard before rendering
7. Department list page fetches via `departmentQueries.getAllWithCounts()` → DepartmentCardGrid
8. Department detail page fetches via `departmentQueries.getByIdWithRelated()` → DepartmentForm + CourseTable + Faculty tab
9. Course CRUD in CourseTable calls server actions in `course-actions.ts` → revalidates department detail page

## Edge Cases
- Profile missing after signup: `getProfileById()` auto-creates via `ensureProfile()`
- Auth check in layout does NOT redirect (middleware handles that — avoids redirect loops)
- `PGRST116` error code from Supabase means "no rows found" — not a real error for profiles

## Security Model (3 layers for /admin/*)
1. **Middleware** — blocks unauthenticated access to `/admin/*` → redirects to /login
2. **Admin layout** — blocks non-institution_admin users → renders "Access Denied" card
3. **Server actions** — each action independently verifies institution_admin role before mutations

## Known Issues
- Dashboard page and layout both independently fetch profile (double query)
- Dashboard To-do list (`src/components/shared/TodoList.tsx`) is hardcoded mock data, not real
- Department detail tabs: Courses has full CRUD via CourseTable; Faculty is still read-only

## Assignment Studio (assignments/*)
Professors create assignments via a wizard (accepted file types + optional text), grade in a
segmented queue (Needs grading / Returned / Graded / Not submitted), and can request changes;
students submit files + optional text and resubmit. Files live in the private
`assignment-submissions` storage bucket (owner/staff RLS), uploaded server-side via the admin
client. Non-submitters past due are auto-graded 0 by a pg_cron job. Full design &
implementation record: `docs/designs/assignments-grading/assignment-studio-consolidated.md`.

## Testing Considerations
- Test dashboard renders for each role (institution_admin, professor, student)
- Test with user who has no profile (auto-creation path)
- Verify middleware redirects unauthenticated users to /login
- Verify metrics show correct counts vs actual database rows
- Test error boundary by simulating a component error

## Current Structure
```
(dashboard)/
├── layout.tsx                                  # Shared layout with sidebar
├── error.tsx                                   # Error boundary
├── dashboard/page.tsx                          # Role-aware landing
├── admin/
│   ├── layout.tsx                              # Role guard — institution_admin only
│   ├── page.tsx                                # Admin dashboard (stats, charts, activity)
│   ├── departments/                            # Department CRUD
│   ├── professors/                             # Professor management
│   ├── courses/                                # Course assignment management
│   ├── programs/                               # Program management
│   └── students/                               # Student management
├── professor/
│   ├── page.tsx                                # Professor dashboard
│   ├── courses/page.tsx                        # My courses grid
│   ├── calendar/page.tsx                       # Office hours scheduler
│   ├── warehouse/page.tsx                      # Knowledge warehouse / My Library
│   └── courses/[sectionId]/
│       ├── about/                              # Block-based about page builder (course root IS the About page;
│       │                                       #   embedded Athena: 'about' authoring kind — fills blocks, derives the
│       │                                       #   schedule from real course data, drift-checks the page, reviews/
│       │                                       #   stress-tests policies, imports a syllabus via attachment)
│       ├── announcements/                      # Announcement CRUD
│       ├── modules/                            # Module/item management
│       ├── quizzes/                            # Quiz CRUD + question bank + settings + insights (preview lives in the studio)
│       │   └── actions.ts                      # Server actions: CRUD quizzes, question bank, quiz settings
│       ├── assignments/                        # Assignment management
│       ├── grades/                             # Grade overview
│       ├── enrollment/                         # Read-only roster (enrollment is admin-driven)
│       ├── roadmap/                            # The course roadmap (RoadmapPrototype: React Flow canvas;
│       │                                       #   roadmap-annotations: hand-drawn annotation layer + per-node
│       │                                       #   emphasis; class lens + tracked skills drawers). Read-only:
│       │                                       #   node status is derived from coverage, never hand-ticked
│       ├── projects/                           # Project workspace CRUD
│       └── classroom/                          # Live session management
└── student/
    ├── courses/page.tsx                        # Enrolled courses (admin-enrolled; no self-serve catalog)
    ├── courses/actions.ts                      # dropSection — self-unenroll, gated by institution policy window
    ├── courses/[sectionId]/
    │   ├── announcements/                      # View announcements (reactions, comments)
    │   ├── modules/                            # View modules
    │   ├── quizzes/                            # Take quizzes + attempt/results
    │   │   └── actions.ts                      # Server actions: start/save/submit attempts, get results
    │   ├── assignments/                        # View assignments
    │   ├── grades/                             # View grades
    │   ├── roadmap/                            # Roadmap viewer — own coverage %, node checks, check-offs
    │   ├── projects/                           # Project workspace
    │   └── classroom/                          # Live session participation
    ├── office-hours/                           # Book office hours
    ├── profile/                                # Edit profile
    └── grades/                                 # Global grades view
```

## Last Updated
2026-06-17 — added Assignment Studio (assignments + submissions, grading, auto-zero)
