# Drawings Folder

Live + persistent slide annotations. Strokes broadcast over the room's
ephemeral channel for sub-100ms peer rendering, then bulk-persisted to
the dedicated `lc_slide_annotations` table for late joiners and reloads.

| File | Purpose |
|------|---------|
| `types.ts` | `Stroke`, `StrokePoint`, and `MAX_STROKES_PER_BATCH` constants shared across client + server |
| `send-stroke.ts` | Client helpers: `sendStroke()` + `sendClear()` write directly to `channel.send()` on the `room:<id>:ephem` topic — no server hop |
| `actions.ts` | Server actions: `persistStrokes()` bulk-inserts into `lc_slide_annotations` (auth + ownership + rate limit via `lc_try_drawings_lock`); `clearSlideAnnotations()` permanently deletes a slide's strokes (prof only) |
