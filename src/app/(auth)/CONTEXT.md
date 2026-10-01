# Auth Feature Context

## What This Does
Handles user authentication: login, signup. Both pages are client components using the browser Supabase client. Auth redirects are handled solely by middleware.

## Files

| File | Type | Purpose |
|------|------|---------|
| `login/page.tsx` | Client Component | Login form, calls `supabase.auth.signInWithPassword` |
| `signup/page.tsx` | Client Component | Signup form, calls `supabase.auth.signUp` |

## Flow

### Signup
1. User enters name, email, password
2. `supabase.auth.signUp()` called with name in user metadata
3. User created in `auth.users`
4. Trigger `handle_new_user` creates row in `profiles` with role='student'
5. (Email confirmation disabled for dev)
6. Success screen shown with "Check your email" message

### Login
1. User enters email, password
2. `supabase.auth.signInWithPassword()` called
3. On success: session created, redirect to `/dashboard`, router refresh
4. On error: error message displayed, logged via `logger.error`

### Auth Protection (Middleware)
- `/dashboard/*` routes redirect unauthenticated users to `/login`
- `/login` and `/signup` redirect authenticated users to `/dashboard`
- All auth redirects happen in `src/middleware.ts` — NEVER in page/layout components
- **RULE 2 exempts server-action POSTs** (`next-action` header). A Next.js server action
  POSTs to the URL of the page that invoked it, so an action called from `/login` posts to
  `/login` — and once `signInWithPassword` has set the cookies, RULE 2 matched the action's
  own POST and 307'd it. The action body never ran. This silently broke EVERY server action
  reachable from `/login`, `/signup` and `/forgot-password`; `profiles.last_login_at` was
  NULL for every account in production as a result (#731). If you add a rule here, ask
  whether it can match an action POST.

### The hash is invisible to the server
Recovery and invite links carry their tokens in the URL **fragment**
(`#access_token=…&type=recovery`), which is never sent to the server — so middleware
cannot see them and its `?invite` / `?code` query bypass never fires. A reset link opened
while signed in as someone else was therefore discarded in silence (#728).
`RecoveryLinkHandoff`, mounted on the `(dashboard)` layout, is the client-side
counterpart: it reads the fragment, strips it, and offers to complete the handoff. Note
`createBrowserClient` runs the PKCE flow, which looks for `?code=` and ignores an
implicit-flow hash entirely — which is why the tokens are still usable when it gets them.

## Dependencies
- `@/lib/supabase/client` (browser-side auth)
- `@/lib/logger` (error and event logging)
- `@/components/ui/*` (shadcn components: Card, Input, Label, Button)

## Database Tables Touched
- `auth.users` (Supabase managed — created on signup)
- `profiles` (auto-created via `handle_new_user` trigger)

## Edge Cases
- Profile auto-creation trigger (`handle_new_user`) may not fire — `ensureProfile()` in `queries.ts` handles this as a fallback
- Email confirmation is disabled for dev — signup goes straight through
- All signups default to 'student' role regardless of email pattern
- Supabase signUp does not throw on duplicate email — returns a fake user object with a null session
- Role detection by email pattern not yet implemented (manual DB update needed for admin/professor)

## Testing Considerations
- Test login with valid credentials -> redirects to /dashboard
- Test login with invalid credentials -> shows error message, logged as `[SCHOLERA ERROR]`
- Test signup with new email -> shows success / check-email message
- Test signup with existing email -> verify behavior (Supabase returns misleading success)
- Test accessing /dashboard without auth -> middleware redirects to /login
- Test accessing /login while authenticated -> middleware redirects to /dashboard

## Password rules live in one place
`src/lib/validations/password.ts` owns the floor AND the whitespace check —
`passwordProblem(password, label)` is the single judge, used by `/reset-password`,
`SetPasswordDialog` and `ChangePasswordSection`. It rejects an all-whitespace password
rather than trimming it: trimming would silently change what the reader typed, and would
disagree with sign-in, which deliberately trims the identifier but never the password.

## TODO
- [x] Add logout button (implemented in Phase 1 via `DashboardHeader` + `actions.ts`)
- [x] Forgot password flow (implemented; `/forgot-password` + `/reset-password`)
- [ ] Role-based redirect after login (Phase 2)
- [ ] Better error messages with specific guidance
- [ ] Social auth (SSO) support

## Last Updated
2026-02-22
