# Staff Route Tree

Role-guarded area for users with `profile.role === 'staff'` (teaching assistants and graders).

| File | Purpose |
|------|---------|
| `layout.tsx` | Role guard — blocks any user who is not `role = 'staff'` |
| `courses/page.tsx` | "My Sections" list — shows every active TA/grader assignment for the signed-in user |
| `courses/[sectionId]/page.tsx` | Per-section view (placeholder) — verifies active membership before rendering, shows instructor + access window |

### How access works

- **Identity:** `profiles.role = 'staff'` (set when admin approves a TA/grader request).
- **Per-section:** `section_staff` row with `status = 'active'` and `ends_at > now()`.
- **Enforcement:** Layout blocks non-staff; each page re-verifies active membership via `sectionStaffQueries.listActiveForStaff`.
- **Expiry:** Access ends automatically when `ends_at` passes — no cron needed, RLS + query filter handle it lazily.
