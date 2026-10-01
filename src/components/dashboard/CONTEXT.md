# Dashboard Components Context

## What This Does
Shared UI components used across all dashboard pages. These are client components because they handle user interactions (dropdown menus, navigation).

## Components

### DashboardHeader
- **File:** `DashboardHeader.tsx`
- **Type:** Client Component (`'use client'`)
- **Props:** `{ profile: Profile | null }`
- **Purpose:** Top navigation bar with Scholera branding, role badge, user avatar dropdown, logout
- **Dependencies:** shadcn `DropdownMenu`, `Avatar`, `Button`; `signOut` server action; `logger`
- **Behavior:** Displays user initials as avatar fallback. Role badge color-coded (red=admin, blue=professor, green=student). Logout calls server action then redirects to /login.

## Database Tables Touched
- None directly (pure UI components receiving data via props)
- Indirectly trigger queries via server actions: `signOut` touches `auth.sessions`

## Edge Cases
- `profile` can be null (renders gracefully with fallback "U" initials and "User" label)
- Logout errors are caught and logged; `isLoggingOut` resets on failure

## Sidebar
- **File:** `Sidebar.tsx` — Desktop sidebar (hidden on mobile), role-aware navigation links
- **File:** `SidebarMobile.tsx` — Sheet drawer for mobile, triggered by hamburger in DashboardHeader

## When to Add Components Here
Place a component in `components/dashboard/` when:
- It is used across multiple dashboard pages (shared header, sidebar, etc.)
- It is dashboard-specific (not reusable outside authenticated context)
- For page-specific components, co-locate them in the page file or a `_components/` subfolder

## Last Updated
2026-08-18
