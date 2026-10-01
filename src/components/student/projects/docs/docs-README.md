# Project Docs (Canvases) Components

Team-scoped multi-canvas feature. Each team has one pinned "Planning" doc
(migrated from the legacy `project_teams.planning_doc` column) plus any
number of additional user-created canvases. Docs are rendered/edited inside
a full-screen overlay, listed in the Discussions sidebar's Resources section.

| File | Purpose |
|------|---------|
| `DocEditorDialog.tsx` | Full-screen overlay hosting `PlanningEditor` for a single doc. Inline title edit, 1500ms debounced autosave, Esc-to-close, optional delete. |
| `CanvasTypePickerDialog.tsx` | Small modal asking which kind of canvas to create before hitting the server. Single-option today (Document); kept as its own step so new tile types can be added without changing callers. |
| `ProjectResourcesSection.tsx` | Sidebar list of team canvases with + Add / Rename / Delete actions. `+` opens `CanvasTypePickerDialog`; picking a type creates the canvas and opens `DocEditorDialog`. |

Server actions live at
`src/app/(dashboard)/student/courses/[sectionId]/projects/docs-actions.ts`
and validation in `src/lib/validations/project-docs.ts`.
