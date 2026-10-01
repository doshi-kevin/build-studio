# Supabase Infrastructure Context

## What This Does
All Supabase interaction code: client factories, database types, and reusable query utilities. Every database operation in the app flows through this directory.

## Files

| File | Purpose |
|------|---------|
| `client.ts` | Browser-side Supabase client (for client components) |
| `server.ts` | Server-side Supabase client (for server components, actions, middleware) |
| `admin.ts` | Admin client (service role key, bypasses RLS, server-side only) |
| `types.ts` | Auto-generated TypeScript types matching the database schema (37 tables) |
| `queries.ts` | Reusable query functions organized by domain (16 modules) |
| `event-logger.ts` | Fire-and-forget audit logging to events table via `logEvent()` |
| `storage.ts` | File upload/delete utilities (buckets: `course-materials`, `project-videos`) |
| `realtime.ts` | Generic `useRealtimeSubscription` hook for Supabase Realtime (`postgres_changes`) |

## Client Architecture

### `client.ts` — Browser Client
- Uses `createBrowserClient` from `@supabase/ssr`
- Used in `'use client'` components (login, signup forms)
- Reads env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Call `createClient()` inside the component (not at module level)

### `server.ts` — Server Client
- Uses `createServerClient` from `@supabase/ssr`
- Handles cookies for auth session management
- **Must be called with `await createClient()`** (async because `cookies()` is async in Next.js 16)
- The `setAll` callback has a try-catch because it fails silently when called from a Server Component (read-only context)

### `admin.ts` — Admin Client
- Uses `createClient` with `SUPABASE_SERVICE_ROLE_KEY`
- **Bypasses all RLS policies** — only use after server-side auth verification
- Used in server actions for mutations: `const adminDb = createAdminClient() as any`
- The `as any` cast works around Supabase TypeScript generic constraints

### When to Use Which

| Context | Client |
|---------|--------|
| `'use client'` components | `client.ts` |
| Server Components (page.tsx, layout.tsx) | `server.ts` |
| Server Actions — reads (`'use server'`) | `server.ts` |
| Server Actions — mutations (`'use server'`) | `admin.ts` (after auth check) |
| Middleware (`middleware.ts`) | Direct `createServerClient` (separate implementation) |

## Types (`types.ts`)

Auto-generated from the Supabase schema. Contains:
- `Database` interface with all table definitions (Row, Insert, Update types)
- Helper type: `TableRow<T>` for extracting row types
- Named exports: `Profile`, `Department`, `DepartmentFaculty`, `Program`, `Course`, `CourseSection`, `Enrollment`, `Event`

**To regenerate:**
```bash
npx supabase gen types typescript --project-id ywdqaoahfmmzcsczxvxn > src/lib/supabase/types.ts
```

**Important:** After regenerating, verify the helper types at the bottom of the file are still present (the generator overwrites the entire file).

## Queries (`queries.ts`)

Organized by domain:
- `dashboardQueries` — `getInstitutionAdminCounts()`, `getStudentCounts()` (professor chips are derived from `professorDashboardQueries.getProfessorTodoSources()`)
- `profileQueries` — `getProfileById()`, `ensureProfile()`
- `courseQueries` — `getProfessorSections()`, `getStudentEnrollments()`
- `enrollmentQueries` — `getSectionEnrollments()`

**Pattern for all queries:**
1. Accept `supabase: SupabaseClient` as first parameter (dependency injection)
2. Wrap in try-catch
3. Log errors via `logger.error('namespace.functionName', error, context)`
4. Return data on success, `null` or `[]` on failure (never throw)

**Adding new queries:**
1. Create or extend an existing domain object in `queries.ts`
2. Follow the existing pattern (SupabaseClient param, try-catch, logger)
3. Add TypeScript types from `types.ts` for return values

## Database Tables

37 tables across the system. Key groups:
- **Core:** `profiles`, `departments`, `department_faculty`, `programs`, `courses`, `course_sections`, `enrollments`, `events`
- **Announcements:** `announcements`, `announcement_reads`, `announcement_reactions`, `announcement_comments`, `announcement_mentions`
- **Content:** `modules`, `module_items`
- **Quizzes:** `quiz_questions`, `quizzes`, `quiz_question_assignments`, `quiz_attempts`, `quiz_answers`
- **Projects:** `projects`, `project_members`, `project_phases`, `project_videos`, `project_showcase`, `future_contributors`
- **GitHub:** `github_connections`, `project_repositories`, `project_commits`
- **Live Classroom:** `lc_rooms`, `lc_interactions` (poll/quiz/question + payload), `lc_responses`, `lc_events`, `lc_decks`, `lc_slide_annotations`, `lc_attendance`, `lc_session_reports`, `lc_recordings`, `lc_transcriptions` (the v1 `classroom_sessions` 8-table model was dropped in the v1→v2 cutover)

## Edge Cases
- `PGRST116` error code = "no rows returned" for `.single()` queries — not always a real error
- `ensureProfile()` exists because the `handle_new_user` trigger sometimes does not fire
- RLS policies must exist on a table before client queries work (returns empty results, not errors)
- `ta_ids` in `course_sections` is a UUID array, not a JSONB array

## Testing Considerations
- All query functions return safe defaults on error (0, null, []) — test error paths
- Test with missing RLS policies to verify graceful failure
- Profile auto-creation path needs special test (delete profile, then call getProfileById)

## Event Logger (`event-logger.ts`)

`logEvent()` takes a single object parameter:
```ts
logEvent({ userId, eventType, sectionId?, metadata? })
```
Fire-and-forget — does not block the calling function. Used in all server actions to audit user actions.

## Storage (`storage.ts`)

- `uploadFile(file, folder)` — uploads to `course-materials` bucket, returns `{ url, path, fileName, fileSize, mimeType }`
- `deleteFile(filePath)` — removes from storage
- `formatFileSize(bytes)` — human-readable size
- `MAX_FILE_SIZE` — default limit constant
- Formula sheets stored at `formula-sheets/{sectionId}/{quizId}/` prefix

## Last Updated
2026-02-22
