# Landing Folder

The public marketing page, rendered by `src/app/page.tsx` (which keeps the Supabase
auth-check server-side and redirects signed-in users to `/dashboard`).

Design: "Modern Clean, amplified" — the app's own design tokens (cool-white
surfaces, one confident blue, Instrument Serif display + Geist body), now defined
globally on `:root` in `globals.css`. Imagery is **real product screenshots** plus two
**AI-generated brand films** scrubbed by scroll. No fabricated testimonials or
stats; the only claim is the US July 2026 launch line.

## Page arc

White hero → desk film (scroll-scrubbed: clutter clears → camera dives into the
laptop's blue screen → the REAL dashboard resolves out of the blue) → claim strip →
product tour with a carved criss-cross path → why-switch → roles bento → security →
FAQ → blue-drench CTA → outro film (camera pulls out, lid closes) → footer.

| File | Purpose |
|------|---------|
| `LandingPage.tsx` | Client root: `MotionConfig` (reduced-motion), nav (blur-on-scroll), section composition, claim strip, footer. |
| `LandingHero.tsx` | White serif hero + CTAs. Shows the static dashboard only when the film won't load (mobile / reduced-motion). |
| `DeskFilm.tsx` | Pinned 300vh intro-film scrub. Enters as an inset rounded cinema card that expands full-bleed; ends with the dashboard emerging (blur + blue wash → sharp) as the film dissolves. |
| `ProductTour.tsx` | Scrollytelling: sticky screenshot panel crossfades while steps scroll; a blue path **carves itself** node-to-node (1→2→3→4) in sync with step activation, with a glowing comet at its tip. Pixel-space SVG (stretched viewBox + non-scaling-stroke breaks dash math in Chromium). |
| `LandingSections.tsx` | Why-switch statement, asymmetric roles bento, security strip, FAQ accordion, final CTA blue drench. |
| `OutroFilm.tsx` | Pinned 200vh closing-film scrub after the CTA. Opens on the CTA's blue (gradient bridge), ends contracting back into a cinema card before the footer. |

## Films & assets

- Films live in **Supabase Storage** (`landing-assets` public bucket, prod project),
  NOT in git — `public/landing/*.mp4|*.mov` is gitignored. Re-encode pipeline for new
  takes: MetalFX upscale 720p master → 2560×1440 (`fx-upscale`), then
  `ffmpeg -an -c:v libx264 -preset slow -crf 23 -g 1 -pix_fmt yuv420p -movflags +faststart`.
  **`-g 1` (every frame a keyframe) is required** — scroll-scrubbing seeks per frame.
- The poster (`hero-film-poster.jpg`, first frame) and screenshots stay in the repo.
- Screenshots: captured from the demo tenant at 1440×900, chrome hidden.

## Motion rules (hard-won)

- framer-motion only; transform/opacity/filter/clip-path only; `MotionConfig
  reducedMotion="user"` plus manual gates on scroll-linked values.
- **Scrubbed opacities must use FUNCTION-form `useTransform`**: keyframe-form
  opacity gets compiled to a native ViewTimeline (WAAPI) animation that tracks
  element visibility, finishes early inside pinned/sticky stages, and snaps the
  value back (text reappearing over the product was this bug).
- **Never `overflow-x-hidden` on an ancestor of `position: sticky`** — it becomes a
  scroll container and silently kills the pin. Use `overflow-x-clip`.
- Videos are scrubbed by writing `video.currentTime` from scroll progress; they
  never autoplay. Mobile / reduced-motion never mount the `<video>` elements.
