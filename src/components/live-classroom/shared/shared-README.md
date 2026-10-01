# Shared Live-Classroom Components

UI pieces used by BOTH the professor and student surfaces. Anything
role-specific lives under `src/components/professor/live-classroom/` or
`src/components/student/live-classroom/`.

| File | Purpose |
|------|---------|
| `SlideAnnotationLayer.tsx` | Canvas overlay over the slide image — handles pointer-down/move/up, slide-relative coordinate math (object-contain), live broadcast on the ephemeral channel, batched persistence every ~2s, and the live `drawing_clear` round-trip. Portals the toolbar into `#lc-annotation-toolbar-slot` when present, falls back to inline overlay otherwise |
| `AnnotationToolbar.tsx` | Position-agnostic pill: pen/eraser toggle, color swatches, stroke width, clear-all. `theme: 'light' \| 'dark'` adapts to the surrounding chrome (light below the slide, dark over fullscreen black) |
| `RoomTimeline.tsx` | Vertical activity log shared by prof + student sidebars — renders a chronological feed of meaningful lifecycle events (poll opened, question asked, class ended). High-frequency events like slide changes and stroke broadcasts are intentionally excluded |
