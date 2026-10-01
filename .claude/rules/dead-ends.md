---
paths:
  - "src/app/**/*.tsx"
  - "src/app/**/*.ts"
  - "src/components/**/*.tsx"
---

# Dead-End Rules — every unreachable route gets a way out

Governs what the user sees when something they asked for isn't there: a missing
record, a resource in another institution, a course they aren't enrolled in, a
feature the professor turned off, a revoked link. Visual styling, empty-state
composition and error-copy tone live in `ui-design.md` (`## Empty States`,
`## Friendly Abstractions & Error Handling`) — do not restate them here.

**This is a lookup table, not a judgement call.** Match the situation, apply the
treatment. Do not weigh alternatives per case.

## Pick the treatment by asking: is there still a working page to stay on?

| Situation | Treatment |
|---|---|
| A URL the user navigated to can't resolve — missing row, cross-tenant, not enrolled, feature toggled off | `notFound()` from `next/navigation` |
| The user's ROLE can't enter a whole area — professor on `/student/*`, student on `/admin/*` | role layout renders `<DeadEnd variant="no-access">` **and the page guards itself** (see below — the layout alone does not stop the page) |
| An action from a working page failed — save, delete, generate, submit | `toast.error(...)`, stay on the page |
| The page loaded and a region has no data yet | `<EmptyState>` in that region |
| The page loaded and one region's fetch failed | inline retry or `toast.error(...)` |
| The route moved or was folded into another | `redirect()`, unconditional |
| Something threw unexpectedly | let it reach `error.tsx` |

## A layout denial does NOT stop the page — guard the page too

**IMPORTANT: a layout that denies by RETURNING `<DeadEnd>` does not prevent the page
from running.** Layout and page segments render in PARALLEL, so the page's server
component still executes and still streams its data into the response — the reader
sees the dead end, but the payload is in the network tab. Same for a layout that
`notFound()`s when the route has a `loading.tsx`: the page sits in its own Suspense
boundary and its chunk is flushed anyway.

This is how ten pages leaked another institution's roster PII and lecture PDFs to any
logged-in student (audit 2026-08-06, PR #555). The layout was doing exactly what the
table above prescribes; that was never enough on its own.

**So: any page that fetches data the viewer may not see re-checks authorization
itself**, before the fetch — `verifyInstitutionAdmin()` / `verifySuperAdmin()` for the
admin tiers, an enrollment lookup or `verifyFeatureEnabled()` for student course
routes. Treat the layout's `<DeadEnd>` as the *visible* denial and the page's own
guard as the *actual* one.

```ts
// admin page — the guard precedes every privileged fetch
const auth = await verifyInstitutionAdmin('ThisPage')
if ('error' in auth) return null   // layout renders the no-access DeadEnd around this slot
const adminDb = createAdminClient() as any
```

Returning `null` is correct **only here**, and only because the layout is already
rendering a visible dead end around the slot — see the never-return-null rule below.

## `missing` vs `no-access` is a security decision

`DeadEnd` has two variants; picking one is about what the copy is allowed to admit:

- **`no-access` is ONLY for role-AREA boundaries** (the five role layouts under
  `(dashboard)`), where the area's existence is public knowledge — saying "you
  can't enter the professor area" reveals nothing.
- **Anything keyed by a resource ID stays `missing` / `notFound()`.** "You don't
  have access to this course" confirms the course exists — a cross-tenant
  existence oracle. If you can't prove the user owns the resource, it "doesn't
  exist".
- Do not use `forbidden()`/`unauthorized()` from `next/navigation` — they require
  `experimental.authInterrupts`, which this repo does not enable. Role layouts
  render the denial directly; they already hold the profile.

## Route dead ends — always the native primitive

- **Always call `notFound()`.** Never `router.push('/404')`, never a custom
  `/unauthorized` route, never an inline error panel returned from the page. Only
  `notFound()` reaches a `not-found.tsx` boundary, and the boundaries are the only
  place the recovery UI lives.
- **`DeadEnd` (`src/components/ui/dead-end.tsx`) is the surface.** Every
  `not-found.tsx` and every role-layout denial renders it. Its `action` prop is
  required — a dead end with no exit isn't finished. Title and description
  default to vetted, tenant-safe copy per variant: **prefer the defaults**, and
  override only when the surface genuinely needs its own wording.
  - One exception: the `(projector)` boundary uses `ProjectorMessage` instead —
    the wall display has a zero-controls spec, so no CTA may render there.
- **Existing boundaries already cover most routes**, so a new `notFound()` call
  usually needs no new file: `src/app/(dashboard)/not-found.tsx` catches every
  authenticated route and keeps the header + sidebar;
  `src/app/not-found.tsx` catches public and unmatched URLs;
  `src/app/(projector)/not-found.tsx` catches the projected classroom view;
  `{professor,student}/courses/[sectionId]/not-found.tsx` catch dead ends inside
  a valid course.
- **Course URLs hide the main Sidebar by URL pattern** (`HIDE_SIDEBAR_PATTERN`
  in `Sidebar.tsx`) in favor of the section layout's icon rail — so a course
  dead end MUST be caught by the `[sectionId]`-level boundary (which renders
  inside the section layout, rail intact). A boundary above the section layout
  renders with no left nav at all. Known residual: `notFound()` thrown by the
  section layout itself (bad `sectionId`) can only bubble upward, so that page
  is header + CTA only.
- **Add a route-level `not-found.tsx` only to change the exit destination**, e.g.
  `admin/departments/[departmentId]/not-found.tsx` points back at the list.
  **`not-found.tsx` receives no props and no route params** — so an exit href built
  from a `[param]` is impossible; fall through to the group boundary instead.
- **`/dashboard` is the correct home href for every authenticated role.**
  `(dashboard)/dashboard/page.tsx` routes `institution_admin` → `/admin` and
  `super_admin` → `/super-admin`, so no boundary needs to fetch a profile or
  branch on a role to build its exit.

## Never confuse "not there" with "broke"

- **Never `notFound()` on a query error.** A 404 asserts the thing doesn't exist;
  a failed fetch means we don't know. Split the conditions.
  - ❌ `if (result.error || !result.data) notFound()`
  - ✅ `if (result.error) { logger.error(...); throw new Error(...) }` then
    `if (!result.data) notFound()`
- **Never `return null` from a page or layout** — with one exception. A blank screen
  is the worst dead end: the user can't tell it from a hung tab. Either `notFound()`
  or render a state. The exception is the authorization guard above, where the role
  layout is already rendering a visible `<DeadEnd>` around the slot, so nothing blank
  reaches the user. Outside that case the rule stands.
- **Never `redirect()` in place of a dead end.** A server redirect can't explain
  itself, so the user just gets teleported and assumes they misclicked.
- **Never `toast.error(...)` from `(auth)` or `(projector)`** — neither route group
  mounts a `<Toaster>`, so the toast is silently swallowed. Render a state instead.

## Dead-end copy must not leak tenancy

Cross-tenant denials deliberately surface as 404s (see `security-server-actions.md`),
so **wording that distinguishes "doesn't exist" from "you can't see it" is a
tenant-existence oracle.** Fuse the two.

- ✅ "It may have been removed, or you may not have access to it."
- ❌ "You don't have permission to view this course." — confirms it exists.
- ❌ "This belongs to another institution." — names the tenant boundary outright.
- Never print the status code, the path, or a raw ID on screen. Log those via
  `logger`; the user gets plain language and a way out.
