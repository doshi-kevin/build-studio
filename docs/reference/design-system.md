# Scholera Design System — Developer Handoff

> **In this repo.** This is the company design handoff, copied unchanged from the marketing site (scholera-inc.com). Its file references (`src/components/sections/*`, `scholera-home.tsx` and so on) point at the marketing repo, not this one. Here:
> - The happy Bloub mascot is `public/images/mascot-happy.svg`. It's the same file, plus one rule that stops its loop under reduced motion.
> - Studio is the first surface built against this spec. Its tokens are the `.studio-brand` block in `src/app/globals.css`, and its generated tools use `public/studio-runtime/v2/kit.css`.
> - The rest of the app still uses the older "Modern Clean" theme in `globals.css`. Moving it over is a separate decision.

> **Purpose.** This document extracts the visual language of the Scholera marketing site (scholera-inc.com) so the product platform (app.scholera-inc.com) looks and feels like the same company.
>
> **What it covers.** It lists the tokens, type, components, motion and voice to build against. It also lists the things on the landing page that are **accidents, not decisions**, which you should not copy.
>
> **Source of truth.** Every value here was taken from the code in this repo. The main sources are `src/app/globals.css`, `src/lib/fonts.ts` and the homepage sections in `src/components/sections/*`. File references are given so you can check the original.
>
> **How to read it.**
> - §1–§8 are the **system**, meaning what to build with.
> - §9 is **marketing-only** flourish that should stay on the website.
> - §10 is the **do-not-copy** list.
> - §11 is the handoff checklist.

---

## 0. The feel in one paragraph

Scholera is **calm, bright and editorial**. Most surfaces are near-white on soft blue-tinted grays, and there is one confident blue. Headlines are tight and heavy (Plus Jakarta Sans), with a single **serif italic accent word** (Instrument Serif) when we want warmth. Depth comes from **soft, blue-tinted shadows and frosted glass**, not borders or heavy chrome. Motion is **quick to start and gentle to land** (ease-out-quint), and it never hides content. There are deep "Athena blue" surfaces for moments that matter, such as AI features, security and CTAs. A friendly blob mascot (Bloub) and the AI assistant (Athena) give the product its personality.

**Three words:** *Clear. Warm. Precise.*

---

## 1. Color

### 1.1 Core tokens (canonical)

These are the values in `src/app/globals.css` `@theme`. **Use these names in the platform.**

| Token | Hex | Use |
|---|---|---|
| `primary` | `#276EE1` | Brand blue. Primary actions, links, active states, focus ring |
| `primary-hover` | `#1F5FC7` | Hover/pressed for primary |
| `primary-light` | `#EBF3FC` | Selected rows, soft fills, tinted icon tiles |
| `primary-foreground` | `#FFFFFF` | Text on primary |
| `ink` *(new; see note)* | `#090B0D` | Display headings |
| `foreground` | `#14191F` | Body text, UI text |
| `muted-foreground` | `#646971` | Secondary text, captions, placeholders |
| `background` | `#F9FAFB` | App canvas |
| `card` / `surface` | `#FFFFFF` | Cards, panels, popovers |
| `muted` | `#F2F4F6` | Subtle fills, hover rows, segmented-control tracks |
| `border` | `#E3E5E8` | Default 1px dividers and card edges |
| `border-bold` | `#CFD4DA` | Input borders, emphasized dividers |
| `ring` | `#276EE1` | Focus ring (use at ~15–25% alpha, 3–4px) |

> **Note on `ink`.** `#090B0D` is used as the heading color in about 160 places on the homepage, but it was never tokenized. Add it as `--color-ink` in the platform. Use `ink` for headings and `foreground` for everything else.

### 1.2 Accent palette

Accents are used sparingly: one accent per component, never two competing.

| Token | Hex | Light tint | Meaning in the product |
|---|---|---|---|
| `violet` | `#855DD7` | `#F4F0FF` | **Teacher/professor** side; also AI "deep" gradient end |
| `sky` | `#4DA3FF` | `#EAF4FF` | Gradient mid-stop, informational highlights |
| `cyan` | `#00B5B5` | `#ECFEFF` | Gradient end-stop, "connected/synced" accents |
| `emerald` | `#2E9052` | `#DEF6E3` | Success, completed, online |
| `coral` | `#E94459` | `#FFF1F2` | Error, destructive, **Live** indicator |
| `amber` *(proposed)* | `#F5B83D` | `#FFF7E0` | Warning, due-soon, "shaky" mastery |

**Role coding (keep this consistent everywhere):**
- **Students** use **blue** (`primary`).
- **Teachers** use **violet** (`violet`).
- This coding comes from the Problem → Solution section, which splits cards into blue (students) and violet (professors). See `disconnected-section.css:199-246`.

**Mastery scale**, from Key Features (`KeyFeatures.tsx:528`):

| Level | Hex |
|---|---|
| weak | `#F0503C` |
| shaky | `#F5B83D` |
| strong | `#2FBF71` |

Reuse this scale for any skill or progress heatmap.

### 1.3 Gradients

| Name | Value | Use |
|---|---|---|
| **Brand** | `linear-gradient(100deg, #276EE1, #4DA3FF 50%, #00B5B5)` | `.bg-gradient-brand`, `.text-gradient-brand`: hero accents, 1px gradient borders |
| **Deep** | `linear-gradient(100deg, #1F5FC7, #276EE1 50%, #855DD7)` | AI and "intelligence" moments |
| **Button** | `linear-gradient(180deg, #2F7AE8, #1C56BA)` | Hero CTA and active state of the Student/Teacher pill toggle |
| **Athena surface** (dark) | see below | Full-bleed dark sections (AI, Security, footer CTA). §1.4 |

### 1.4 Dark "Athena blue" surface

This is the signature dark surface. It is used in the Key Features, Athena (Scolar) and footer CTA sections.

```css
background:
  radial-gradient(75rem 42rem at 70% 10%, color-mix(in oklab, oklch(0.78 0.09 250) 38%, transparent), transparent 68%),
  radial-gradient(58rem 34rem at 52% 110%, color-mix(in oklab, oklch(0.28 0.18 252) 70%, transparent), transparent 68%),
  linear-gradient(112deg, oklch(0.34 0.18 252), oklch(0.42 0.19 252) 52%, oklch(0.52 0.16 248));
```

Optional layers on top:
- A **white dot grid**: `radial-gradient(circle, white 1px, transparent 1px)` at `28px 28px`, opacity `0.06`.
- Two blurred glow blobs: `oklch(0.65 0.22 250)` at 20% opacity with `blur(90px)`, and `oklch(0.55 0.18 280)` at 15% opacity with `blur(80px)`.

Text on this surface:
- Headings: white.
- Body: `white/65–80%`.
- Labels: `white/55–60%`.

In the platform, use this surface for the **Athena / AI panel header, onboarding splash and empty-state heroes**. Do not use it as a general app background. For a true dark mode, see §1.6.

### 1.5 Shadows (blue-tinted, soft, negative spread)

| Token | Value | Use |
|---|---|---|
| `shadow-sm` | `0 1px 2px rgba(20,25,31,.05)` | Inputs, small chips |
| `shadow-md` | `0 12px 28px -18px rgba(20,25,31,.22)` | Cards at rest |
| `shadow-lg` | `0 24px 60px -30px rgba(20,25,31,.28)` | Popovers, raised cards |
| `shadow-xl` | `0 32px 80px -36px rgba(39,110,225,.32)` | Modals, hero panels |
| `glow-brand` | `0 18px 46px -14px rgba(39,110,225,.55)` | Primary CTA only |

**Rule:** shadows are large and soft with a negative spread, and they are tinted toward navy or brand blue, never neutral black. Do not stack a hard border and a heavy shadow on the same element.

### 1.6 Dark mode (proposal, not yet on the site)

The marketing site is light-first. For a platform dark mode, derive it from the existing dark surfaces:
- Canvas: `#07111F`.
- Surface: `rgba(10,23,42,.82)`.
- Text: `#F8FBFF`.
- Muted text: `rgba(222,233,248,.68)`.
- Border: `rgba(151,216,255,.16)`.

These values already exist in the homepage dark-canvas overrides (`globals.css:365-396`). Keep `primary` unchanged.

---

## 2. Typography

### 2.1 Families

These are loaded with `next/font` in `src/lib/fonts.ts`.

| Role | Family | Weights loaded | CSS var | Tailwind |
|---|---|---|---|---|
| Display (headings) | **Plus Jakarta Sans** | 600, 700, 800 | `--font-display` | `font-display` |
| Body / UI | **Inter** | 400, 500, 600, 700 | `--font-sans` | `font-sans` (default) |
| Accent and wordmark | **Instrument Serif** | 400, normal + *italic* | `--font-serif` | `font-serif` |
| Mono (data, code, kbd, eyebrows) | **JetBrains Mono** | *not loaded yet* | `--font-mono` | `font-mono` |

> **Platform action.** Load JetBrains Mono (400/500/600) in the platform. It is declared but not loaded, so it currently falls back to the system mono font. Do not add any other families: three families on screen is the maximum.

### 2.2 How the fonts are used

- **Headings** use Plus Jakarta Sans **Bold (700)** with tight tracking and a line-height of about 1.0.
- **The serif accent.** In a big headline, one word can switch to *Instrument Serif italic, weight 400*, usually in `primary`. Examples: *"See it in **action**"*, *"Schol**era**"*. Use it **at most once per view**. Never set a whole sentence in serif.
- **Two-tone headline.** Line one is in `ink`; line two is in `primary`. For example, "Your entire course." / "One coherent platform." This is the house headline pattern for page-level headers.
- **Body** is Inter Regular at line-height 1.55–1.65, with `text-wrap: pretty`.
- **Eyebrows** are small uppercase labels with wide tracking (spec below).
- **Numbers** in stats and tables use `tabular-nums`.

### 2.3 Type scale

Marketing sizes are larger. The platform should use the **App** column.

| Style | Marketing | **App** | Weight | Line-height | Tracking | Font |
|---|---|---|---|---|---|---|
| Display | 44–56px (`clamp(2.25rem,4vw,3.5rem)`) | 32px | 700 | 1.0 | -0.05em (`tracking-tighter`) | Display |
| H1 / page title | 36–48px | 24–28px | 700 | 1.1 | -0.03em | Display |
| H2 / section | 28–36px | 20px | 700 | 1.2 | -0.02em | Display |
| H3 / card title | 18–20px | 16px | 600 | 1.3 | -0.01em | Display |
| Body L | 17–18px | 16px | 400 | 1.6 | 0 | Inter |
| Body | 15–16px | 14px | 400 | 1.55 | 0 | Inter |
| Small / meta | 13px | 12–13px | 400–500 | 1.45 | 0 | Inter |
| Eyebrow | 11px | 11px | 600 | 1 | **0.18em**, UPPERCASE | Inter or Mono |
| Micro label | 10px | 10px | 600 | 1 | 0.14em, UPPERCASE | Mono |

Global rules (from `globals.css:95-113`):
- `h1–h4` get `letter-spacing: -0.025em` and `text-wrap: balance`.
- The root font size is fluid: `clamp(14px, .875rem + .25vw, 16px)`.

### 2.4 Eyebrow (standardized)

The site has six slightly different eyebrow styles (see §10). Use this single spec:

```html
<span class="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
  <span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
  Student Dashboard
</span>
```

- On dark surfaces, use `text-white/70` with a white dot.
- The mono variant is for system or technical labels such as "SCHOLERA / QUIZ STUDIO": `font-mono text-[11px] uppercase tracking-[0.25em] text-ink/55`.

---

## 3. Spacing, layout and shape

### 3.1 Spacing

Use Tailwind's 4px scale. The common rhythm is:

| Context | Values |
|---|---|
| Inside components | 4 · 8 · 12 · 16 |
| Card padding | 16 · 20 · 24 |
| Between groups | 24 · 32 · 40 |
| Marketing section padding | 64–96 (`py-16 md:py-24`) |

### 3.2 Containers

- Marketing content width: `max-w-6xl` (1152px) with `px-4 sm:px-6`.
- Navbar height: **64px** (`h-16`).
- Platform defaults:
  - Content max width 1280px (`max-w-7xl`).
  - Sidebar about 232px expanded and 64px collapsed. The dashboard mock on the site uses 148px at 0.7 scale, which is about 210px at full size.

### 3.3 Radius

| Token | Value | Use |
|---|---|---|
| `radius-sm` | 6px | Tags, kbd, tiny chips, checkboxes |
| `radius-md` | 10px | **App buttons, inputs, nav items, menu items** |
| `radius-lg` | 14px | Cards, panels, dropdowns, icon tiles (40–44px) |
| `radius-xl` | 18px | Feature cards, large panels |
| `radius-2xl` | 24px | Modals, sheets, hero media frames |
| `radius-full` | 9999px | Segmented toggles, pills, chips, avatars, **marketing CTAs** |

**Shape rules:**
- **Marketing CTAs are pills.** In the app, **buttons use `radius-md`**. Toggles, filter chips and status badges stay pills.
- Nested radius: inner radius = outer radius − padding. For example, a 24px modal with 8px padding has 16px inner cards.

### 3.4 Breakpoints

Use the Tailwind defaults: `sm 640`, `md 768`, `lg 1024`, `xl 1280`. The site was tuned at 390px (small phone), 640px, 900px and 1100px. Test the platform at **390 / 768 / 1280 / 1440**.

---

## 4. Surfaces and materials

### 4.1 Light glass (navbar, floating toolbars, sticky headers)

```
bg-white/50 backdrop-blur-2xl backdrop-saturate-[1.2] border-b border-white/40
shadow-[0_8px_30px_rgba(39,110,225,0.08),inset_0_1px_0_rgba(255,255,255,0.8)]
```

The navbar also has a 1px top hairline in the brand gradient:

```
linear-gradient(90deg, transparent, rgba(39,110,225,.55) 18%, rgba(0,181,181,.45) 50%, rgba(133,93,215,.4) 82%, transparent)
```

Use it on the platform top bar.

### 4.2 Glass card (`.glass` utility)

```css
background: rgba(255,255,255,.62); backdrop-filter: blur(12px);
border: 1px solid rgba(255,255,255,.7); box-shadow: 0 8px 30px -12px rgba(39,110,225,.25);
```

> Glass only works over something colorful. On a flat `#F9FAFB` canvas, use a plain **card** instead (§4.3).

### 4.3 Standard card (the workhorse in the app)

```
rounded-[14px] border border-border bg-card p-5 shadow-[0_12px_28px_-18px_rgba(20,25,31,.22)]
hover: -translate-y-0.5, border-primary/30 (only if the card is clickable)
```

### 4.4 Tinted role card

This comes from the Problem section (`disconnected-section.css:199-222`). Use it for student and teacher activity items. Set `--card-rgb` to `39,110,225` (student) or `133,93,215` (teacher).

```css
border-radius: 18px; border: 1px solid rgba(255,255,255,.75);
background: linear-gradient(135deg, rgba(var(--card-rgb),.08), rgba(var(--card-rgb),.02) 45%, rgba(255,255,255,.65)), rgba(255,255,255,.45);
box-shadow: inset 0 1px 0 rgba(255,255,255,.9), 0 14px 34px -18px rgba(var(--card-rgb),.35);
backdrop-filter: blur(16px) saturate(160%);
```

### 4.5 Icon tile

- Default: a soft tile, `size-10 rounded-[14px] bg-primary/10 text-primary`, with a 20px icon.
- Emphasized: a gradient tile, `42×42`, radius 13px, `linear-gradient(145deg, rgba(rgb,.85), <deep shade>)`, white glyph, `inset 0 1px 0 rgba(255,255,255,.35)` and a colored glow.

---

## 5. Iconography and imagery

- **Icon library:** `lucide-react`, and only that library.
  - Sizes: 14 (inline/meta), 16 (buttons, nav), 20 (tiles, headers), 24 (empty states).
  - Stroke 2 by default; 1.7–1.8 at 20px and above for a lighter feel.
- **Do not** use emoji as UI icons. Key Features uses some (❤️⚡✋), which is acceptable in demo content only.
- **Product screenshots** go in a device frame (laptop) on marketing pages only. In the app, show the real UI.
- **Video:** the `DemoVideo` component (`src/components/video/demo-video.tsx`) is muted, looping and `playsInline`. It plays only when in view (200px rootMargin) and uses a poster at `/videos/posters/<name>.jpg`. Reuse it for in-app tutorials.

---

## 6. Components (platform spec)

These are the components the platform needs, each reconciled from the landing page's variants. Class strings are Tailwind v4.

### 6.1 Buttons

| Variant | Classes (app) | Notes |
|---|---|---|
| **Primary** | `h-10 px-4 rounded-[10px] bg-primary text-white text-sm font-semibold shadow-sm shadow-primary/20 hover:bg-primary-hover active:scale-[0.97] transition-[background-color,transform] duration-200` | One per view |
| **Secondary** | `h-10 px-4 rounded-[10px] border border-border-bold bg-white text-foreground text-sm font-semibold hover:border-primary/30 hover:bg-primary-light hover:text-primary` | Same hover as navbar "Log in" |
| **Ghost** | `h-10 px-3 rounded-[10px] text-muted-foreground hover:bg-muted hover:text-foreground` | Toolbars |
| **Destructive** | `bg-coral text-white hover:bg-coral/90` | Confirm dialogs only |
| **AI / Athena** | Primary plus a leading `Sparkles` icon; while running, add a shimmer sweep (`via-white/25`, 1s linear loop) | "Generate rubric" pattern, `RubricDemo.tsx` |
| **Marketing hero** | `rounded-full bg-gradient-to-b from-[#2F7AE8] to-[#1C56BA] px-6 py-2.5 font-bold shadow-lg shadow-primary/25 hover:brightness-110` | **Website only** |

Sizes: `sm` is h-8 / 13px, `md` is h-10 / 14px, `lg` is h-12 / 15px. Disabled buttons use `opacity-50 cursor-not-allowed`. A loading button keeps its width, shows a `Loader2 animate-spin` and changes its label (e.g. "Generating…").

### 6.2 Inputs

```
h-10 w-full rounded-[10px] border border-border-bold bg-white px-3.5 text-sm text-foreground
placeholder:text-muted-foreground/70
focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15
```

- **Always** use a visible `<label>` (`text-[12px] font-medium text-muted-foreground mb-1.5`). The marketing modals currently use placeholders only; do not copy that.
- **Error state:**
  - Field: `border-coral focus:ring-coral/15`.
  - Message below the field: `text-[12px] text-coral`.
- **Composer (chat with Athena):** `rounded-xl border px-3 py-2`, focus `border-blue-300 ring-4 ring-blue-100`. The send button is a `size-7 rounded-lg` and fills with primary when there is text.

### 6.3 Segmented control / toggle (signature component)

This is the Student/Teacher toggle and the feature tabs. Every view switcher in the app should use it.

```
Track:   inline-flex gap-1 p-1 rounded-full border border-gray-200/70 bg-gradient-to-b from-white to-gray-50/80
         shadow-[0_8px_24px_-8px_rgba(15,23,42,.12),inset_0_1px_0_rgba(255,255,255,.9)] backdrop-blur-md
Item:    px-4 py-2 rounded-full text-xs font-semibold text-gray-500 hover:text-gray-900 flex items-center gap-2
Active:  bg-gradient-to-b from-[#2F7AE8] to-[#1C56BA] text-white shadow-sm shadow-primary/30
```

- The active background is a single element that **slides** using Motion `layoutId`, with spring `{ stiffness: 380, damping: 32 }`.
- Compact in-app variant (tabs inside a card): track `rounded-[10px] bg-muted p-1`; item `rounded-lg px-3 py-1.5 text-xs font-semibold`; active `bg-white text-foreground shadow-sm`.

### 6.4 Chips and badges

| Type | Classes |
|---|---|
| Filter / suggestion chip | `rounded-full border border-primary/15 bg-primary-light px-2.5 py-1 text-[11px] font-medium text-primary hover:border-primary/40` |
| Neutral tag | `rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground` |
| Status badge | `rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]`, tinted fill using the semantic color at 10% and the text at 100% |
| Live badge | `bg-coral text-white`, mono 11px, `tracking-[0.2em]`, `animate-ping` dot |
| Count | `rounded-full bg-primary/10 text-primary text-[11px] font-semibold px-1.5 min-w-5` |

Status mapping:

| State | Color |
|---|---|
| Needs review / late / error | `coral` |
| Due soon / warning | `amber` |
| In progress / info | `primary` |
| Done / saved / online | `emerald` |
| Draft / queued | `muted` |

### 6.5 Data display

These come from the dashboard mock in `scholera-home.tsx`.

- **Metric card:** `min-h-[72px] rounded-lg border border-border bg-card p-3 shadow-[0_3px_10px_rgba(20,25,31,.035)]`.
  - Label: `text-xs text-muted-foreground`.
  - Value: `text-2xl font-semibold tabular-nums`, with a `CountUp` animation on first view only.
- **Stats strip:** a 3-column grid with `divide-x divide-border rounded-2xl border bg-white/70`.
  - Value: `text-2xl font-black`.
  - Label: `font-mono text-[10px] uppercase tracking-widest text-muted-foreground`.
- **Task / list row:** `grid grid-cols-[auto_1fr_auto] gap-3 px-4 py-3 hover:bg-muted/60`, with a `divide-y divide-border` list. Leading circle checkbox `size-4 rounded-full border`; trailing due chip.
- **Progress dots / pager:** 7px dots in `border` color. The active dot becomes a 23px `primary` pill, transitioning `width .35s, background .35s`.
- **Tables:** header `bg-muted text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground`; rows `h-12 border-b border-border`; numbers right-aligned with `tabular-nums`.

### 6.6 Navigation

- **Top bar:** light glass (§4.1), 64px, logo plus the *Schol**era*** wordmark (Instrument Serif, `era` in italic).
- **Nav item:** `rounded-[10px] px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground`.
  - Active: `bg-primary-light text-primary`. The dashboard mock uses solid `bg-primary text-white`; either is fine, but pick one and use it everywhere.
- Command menu (⌘K) panel: `rounded-2xl border bg-white shadow-2xl ring-1 ring-black/5`, `w-[min(92vw,560px)]`. Selected item uses `bg-primary-light text-primary`. The current internal tool uses violet; switch it to primary.

### 6.7 Overlays

- **Modal:**
  - Overlay: `bg-black/40 backdrop-blur-[2px]`.
  - Panel: `max-w-lg rounded-3xl border border-border bg-white p-7 md:p-9 shadow-2xl`.
  - Enter animation: `{y:10, scale:.98} → {0,1}`, 0.3s, ease-out-quint.
  - Required: `role="dialog" aria-modal`, a focus trap, Escape to close, and scroll lock.
- **Popover / tooltip:** `w-64 rounded-xl border border-border bg-white p-3 shadow-[0_20px_50px_-20px_rgba(9,11,13,.35)]`.
- **Dropdown:** use the existing `dropdown-in` keyframe (`scale .96, y -4 → none`, 0.14s).
- **Toast (sonner):** `position="bottom-right"`, `rounded-xl border border-border bg-white shadow-lg`.

### 6.8 Feedback states

- **Skeleton:** `bg-muted` bars (`h-2.5 rounded`) plus a shimmer sweep `from-transparent via-primary/10 to-transparent`, 1.1s loop. Never show a spinner for more than about 1s; use a skeleton instead.
- **Empty state:**
  - Container: `rounded-xl border-2 border-dashed border-border`, centered content.
  - Content: a 20–24px `Sparkles` or other relevant icon in `primary/60`, a title (`text-sm font-semibold`), a single sentence of help (`text-xs text-muted-foreground max-w-[240px]`), and one action.
  - Optionally add the Bloub mascot.
- **Saving indicator:** a `Loader2` labelled "Saving…" cross-fades to a `Check` (emerald) labelled "All changes saved", `text-[10px] text-muted-foreground`.
- **Typing indicator (Athena):** a pill with 3 × `size-1.5` dots bouncing `y [0,-4,0]`, 0.9s, 0.15s stagger.

### 6.9 Accordion

From `faq-section.tsx`:
- Rows: `border-b border-border`, single-open.
- Chevron rotates 180° with spring 300/22.
- Panel animates height 0↔auto over 0.32s ease-out-quint.

### 6.10 AI (Athena) patterns

Athena is the AI assistant, so it needs a consistent visual identity:
- **Avatar:** the Bloub SVG with a blue glow `drop-shadow(0 2px 6px rgba(59,147,240,.45))`. When busy it bobs (`y [0,-2,0]`, 1.1s) and shows a ping halo.
- **User bubble:** `rounded-2xl rounded-br-sm bg-primary text-white px-3.5 py-2.5 text-sm`.
- **Athena bubble:** `rounded-2xl rounded-tl-md border border-border bg-muted/40`.
- **Citations:** inline `rounded-md bg-primary/10 px-1.5 font-mono text-[10px] text-primary` that opens a popover with the source.
- **AI attribution pill:** `rounded-xl border border-primary/15 bg-primary-light px-3 py-1.5 text-xs font-bold text-primary`, with `Sparkles` and text such as "Generated by Athena".
- **Principle:** the copy says Athena *"teaches instead of telling"*, so AI output should guide (hints, steps, sources), not just give answers.

---

## 7. Motion

### 7.1 Tokens

| Token | Value | Use |
|---|---|---|
| `ease-out` (house ease) | `cubic-bezier(0.22, 1, 0.36, 1)` | Almost everything |
| `ease-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` | Large layout moves, hero |
| `ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Looping sweeps |
| `spring-snappy` | `{ stiffness: 380, damping: 32 }` | Sliding indicators (`layoutId`) |
| `spring-soft` | `{ stiffness: 300, damping: 22 }` | Chevrons, small toggles |

| Duration | App | Marketing |
|---|---|---|
| Micro (hover, press) | 120–200ms | 200–300ms |
| UI (menus, tabs, swap) | 200–300ms | 450–600ms |
| Reveal (on scroll) | — avoid in app | 700–900ms |

**Library:** `motion` (`import { motion } from "motion/react"`). The site also ships `framer-motion` and `gsap`; the platform should use **only `motion`**.

### 7.2 Rules

1. **Never hide text to animate it.** Text must be readable on first paint. Do not fade text in from `opacity: 0` and do not reveal it from behind a mask. Animate position only (`y` lift), or add life with a wave or shimmer. The reference implementation is `src/app/about/wave-text.tsx`. It renders in its final position on the server, and its `lift()` animates only `y`.
2. **Animate only `transform` and `opacity`** (and `background-position` for shimmer). Never animate layout properties on hover.
3. **Respect `prefers-reduced-motion`.** Use `useReducedMotion()` to jump to the final state. Turn off loops, parallax and magnetic or spotlight effects.
4. **One motion idea per view.** Product UI should feel instant; save choreography for onboarding and AI moments.
5. **Scroll-triggered reveals use `viewport={{ once: true, margin: "-80px" }}`.** Never replay them.

### 7.3 Reusable patterns

- **Content swap** (tab change): out `y: -6`, in from `y: 6`, 0.25s, `AnimatePresence mode="wait"`.
- **Sliding active pill:** a shared `layoutId` with `spring-snappy`.
- **Count-up** for metrics: 0.8s ease-out on first view only.
- **Press:** `active:scale-[0.97]`.
- **Lift:** hover `-translate-y-0.5` (cards) or `-translate-y-1` (feature cards).

---

## 8. Brand assets and voice

### 8.1 Logo and wordmark

- Logo mark: `public/logo.png`, 40px (mobile) and 48px (desktop) in the navbar.
- **Wordmark:** "Schol*era*" in Instrument Serif, with "era" in italic, `tracking-[-0.03em]`, at 24–36px.
- **Do not** substitute an "S" circle or "S" tile. The footer and admin shell do this today (see §10).
- **Missing:** an SVG logo, a monochrome/white logo for dark surfaces, a favicon set and an app icon. See §11.

### 8.2 Mascot: Bloub

- **Assets:**
  - SVGs in `src/components/assets/`: `mascot-happy.svg`, `mascot-confused.svg`, `studnet.svg`.
  - `public/images/bloub-cercle-mefiant-bleu-anime.svg`.
  - Videos: `public/videos/bloub-default-cycle.mp4` and `public/video/bloub-study-assistant.mp4`.
- **Moods:**
  - **Happy:** success, welcome.
  - **Confused:** errors, empty states, "something's missing".
  - **Student:** student-side onboarding.
- **Use in the app:** onboarding, empty states, the Athena avatar, celebratory moments (first course created, streaks). Keep it to **one mascot per screen**, never as decoration in dense work views.
- **Naming needs a decision.** The hero speech bubble says *"Hey, I'm Scholar 👋"*, the AI is called *Athena*, the files say *Bloub*, and the section folder is `scolar`. Pick one canonical mascot name and one AI name and record them here.

### 8.3 Voice and copy

- **Short, declarative headlines with a period:** "Your entire course. One coherent platform." "Every role gets a real home."
- **Benefit first, plain words:** "Everything in one feed", "Get unstuck instantly".
- **Warm but not cute:** one friendly line, then get out of the way. The mascot can be playful; the UI copy stays clear.
- **Spelling:** the site mixes British and American spelling ("organised", "practise" vs "organized"). **Decide on one locale for the platform**; the current majority is British.
- **Button labels** are verbs: "Book a demo", "Generate rubric", "Publish". Avoid "Submit" and "Click here".

---

## 9. Marketing-only (do not bring into the app)

These effects work on a landing page but would make a product feel slow or noisy:
- Scroll-scrubbed GSAP stories (Problem → Solution), and scroll-expanding section cards (78% → 100% width).
- Laptop and phone device frames, brushed-metal bezels and screen reflections.
- Magnetic buttons, cursor spotlight and 3D tilt.
- Giant watermark text, RGB-split and glitch titles (`ActionTitle`), orbit rings and floating idle loops.
- Ambient blurred orbs drifting behind content, film grain, scroll-snap.
- Fake cursors and auto-playing demo sequences (`demo-kit`). These are useful for **onboarding tours**, not for normal screens.

---

## 10. Known inconsistencies (do not copy these)

These are accidents in the current landing page. Build the platform against §1–§8, not against what you see in DevTools.

| # | Issue | Where | Platform decision |
|---|---|---|---|
| 1 | **The homepage renders `text-primary` as `#0074F1`, not `#276EE1`.** `scholera-home.css` re-imports all of Tailwind and redefines `:root` tokens; its CSS chunk loads after `globals.css`, so its `--primary` wins. | `scholera-home.css:1, 81-166`; also `scholera.css` (own `@theme`) | Use **`#276EE1`**. Fix on the site by scoping those tokens to the section. |
| 2 | Five different "brand blues": `#276EE1`, `#2563EB`, `#3B82F6`, `#0074F1`, `oklch(.53 .22 259)` | Disconnected, Key Features, Experience | `primary` only |
| 3 | Three primary-CTA styles for the same "Book a demo": solid blue, brand gradient, black | navbar, hero, `pilot-cta-button.tsx`, modals | §6.1 |
| 4 | Heading ink `#090B0D` hardcoded about 160×; not a token | site-wide | Add `--color-ink` |
| 5 | `--color-warning` is blue; `--color-accent` equals `primary-light`, so the modal success icon is nearly invisible | `globals.css:14, 28` | `warning` = amber; do not use `accent` as a text color |
| 6 | Internal `/assignments` tool uses **violet + slate**, 8px inputs and a dark header | `src/app/assignments/_form-fields.tsx` | Migrate to these tokens |
| 7 | Six eyebrow variants (10–11px, tracking 0.14–0.38em) | various | §2.4 |
| 8 | Section headings sometimes render in Inter instead of Plus Jakarta Sans | `section-heading.tsx`, `ActionTitle.tsx`, modals | Headings = `font-display` |
| 9 | `scholera-home.css` references DM Sans and Playfair Display, which are never loaded | `scholera-home.css:21-22` | Do not use |
| 10 | `--radius-*` tokens largely unused; Tailwind defaults and arbitrary values used instead | site-wide | §3.3 |
| 11 | Some text fades in from `opacity: 0` (SectionHeading `fadeUp`, modal steps) | `src/lib/animation-variants.ts` | §7.2 rule 1 |
| 12 | Placeholder-only form fields; no `role="dialog"` or focus trap in modals | pilot and waitlist modals | §6.2, §6.7 |
| 13 | Error text uses Tailwind `red-600` | modals | `coral` |
| 14 | Off-brand `::selection` (`rgba(22,25,169,.22)`) and lavender scrollbar (`#C4C2E8`) | `globals.css:160-195` | `primary/20` selection, `border-bold` thumb |
| 15 | Both `framer-motion` and `motion` bundled; `gsap` too | `package.json` | `motion` only |
| 16 | Footer and admin shell use an "S" circle instead of the logo | `footer.tsx`, `admin-shell.tsx` | Real logo |
| 17 | `/video/` and `/videos/` both exist | `public/` | One folder |

---

## 11. Handoff package checklist

This document is the core of the handoff. The pieces below complete it.

**Ready now (in this repo)**
- [x] `DESIGN.md` (this file): tokens, type, components, motion, voice.
- [x] Token source: `src/app/globals.css` (`@theme inline`).
- [x] Font setup: `src/lib/fonts.ts`.
- [x] Reference components to lift:
  - `wave-text.tsx` (text motion)
  - `demo-video.tsx` (lazy video)
  - `scolar/demo-kit/*` (`useSequence`, `CountUp`, `FakeCursor` for onboarding tours)
  - `scolar/create-demo/ChatWindow.tsx` (Athena chat)
  - the dashboard mock in `scholera-home.tsx`
- [x] Mascot SVGs and videos (§8.2).

**To produce (owner: design)**
- [ ] **Tokens as code:** a shared `tokens.css` (Tailwind v4 `@theme`) and/or `tokens.json` package that both repos import, so they can never drift again. The block in Appendix A is a drop-in start.
- [ ] **Logo kit:** SVG mark and wordmark, a white/mono version for dark surfaces, a minimum size, clear-space rules, plus favicon and app-icon PNGs.
- [ ] **Mascot sheet:** each mood with its name, when to use it, minimum size, and do's and don'ts.
- [ ] **Key-screen mockups** (Figma or annotated screenshots) for at least: student dashboard, teacher course view, Athena chat panel, an empty state, a form, and a modal. The landing page shows *marketing* versions; developers need the *real* layouts.
- [ ] **Screenshot reference sheet:** a capture of each landing section (desktop and 390px mobile) so "match the vibe" has a visual target.
- [ ] **Accessibility bar:** WCAG 2.2 AA. Text contrast at least 4.5:1 (`primary` on white is 4.8:1; `muted-foreground` on the canvas is 5.3:1). Visible focus rings on every interactive element. Keyboard support for toggles, menus and modals. Reduced-motion support.
- [ ] **Content decisions:** mascot and AI names (§8.2), UK vs US spelling (§8.3), date and number formats.
- [ ] **Dark mode decision:** ship it or not. If yes, confirm the §1.6 proposal.

**Recommended process**
- [ ] Build a small component library (Button, Input, SegmentedControl, Card, Badge, Modal, Toast, EmptyState, Skeleton) in the platform **first**, before building screens.
- [ ] Add a living "kitchen sink" page (`/design`) in the platform showing every token and component. Review it against the landing page side by side.
- [ ] Fix §10 items 1–5 on the marketing site so both sides read the same tokens.

---

## Appendix A — Drop-in tokens (Tailwind v4)

```css
@import "tailwindcss";

@theme {
  /* brand */
  --color-primary: #276ee1;
  --color-primary-hover: #1f5fc7;
  --color-primary-light: #ebf3fc;
  --color-primary-foreground: #ffffff;

  /* neutrals */
  --color-ink: #090b0d;
  --color-foreground: #14191f;
  --color-muted-foreground: #646971;
  --color-background: #f9fafb;
  --color-card: #ffffff;
  --color-muted: #f2f4f6;
  --color-border: #e3e5e8;
  --color-border-bold: #cfd4da;
  --color-ring: #276ee1;

  /* accents & semantics */
  --color-violet: #855dd7;   --color-violet-light: #f4f0ff;
  --color-sky: #4da3ff;      --color-sky-light: #eaf4ff;
  --color-cyan: #00b5b5;     --color-cyan-light: #ecfeff;
  --color-emerald: #2e9052;  --color-emerald-light: #def6e3;
  --color-coral: #e94459;    --color-coral-light: #fff1f2;
  --color-amber: #f5b83d;    --color-amber-light: #fff7e0;
  --color-success: var(--color-emerald);
  --color-warning: var(--color-amber);
  --color-danger: var(--color-coral);
  --color-info: var(--color-primary);
  --color-student: var(--color-primary);
  --color-teacher: var(--color-violet);

  /* type (next/font must register these variables) */
  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
  --font-display: var(--font-jakarta), var(--font-inter), ui-sans-serif, sans-serif;
  --font-serif: var(--font-instrument), Georgia, serif;
  --font-mono: var(--font-jetbrains), ui-monospace, monospace;

  /* shape */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;
  --radius-2xl: 24px;

  /* depth */
  --shadow-sm: 0 1px 2px rgba(20, 25, 31, 0.05);
  --shadow-md: 0 12px 28px -18px rgba(20, 25, 31, 0.22);
  --shadow-lg: 0 24px 60px -30px rgba(20, 25, 31, 0.28);
  --shadow-xl: 0 32px 80px -36px rgba(39, 110, 225, 0.32);

  /* motion */
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-expo: cubic-bezier(0.16, 1, 0.3, 1);
}

@layer base {
  h1, h2, h3, h4 { letter-spacing: -0.025em; text-wrap: balance; }
  p { text-wrap: pretty; }
  ::selection { background: color-mix(in oklab, var(--color-primary) 20%, transparent); }
}
```

> **Font variables.** The font vars above (`--font-inter`, etc.) assume the platform registers `next/font` variables under those names, and the `@theme` maps them in. This avoids the fragile literal-family-name setup the marketing site uses today.
