# Super Admin Components

Components used exclusively under `/super-admin/*`. Mirrors the structure of `src/components/admin/`.

| Path | Purpose |
|------|---------|
| `institutions/InstitutionsTable.tsx` | Server-rendered table for the institutions list. Includes the `⚠ No admin assigned` warning badge when `admin_count === 0`. |
| `institutions/CreateInstitutionForm.tsx` | Client form for super-admin Create Institution flow. Slug auto-derives from name on first edit. Primary admin section is collapsible / optional. |
