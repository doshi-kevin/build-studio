# Announcements reading pane — no-reflow list + detail — browser walkthrough

**Target:** local dev (`localhost:3000`). Runs below were driven against the **prod** Supabase project, inside the **Scholera Dev** institution only.
**Driver:** Chrome DevTools MCP (see [README.md](./README.md)). See *Driver notes* — the shared-profile contention made an isolated Playwright launch the reliable path for measurement.
**Date:** 2026-07-27
**Build under test:** branch `feature/announcements-reading-pane` — both announcement lists previously expanded cards **in flow** on hover, focus, *and* click, pushing every announcement below them down the page. That expansion is deleted. Professor gets a two-pane reading layout (`?a=<id>`); students navigate to the existing detail page.

> Fixtures (Scholera Dev): professor `professor@scholera.dev` / `<password in .env.local>`, student `student@scholera.dev` / `<password in .env.local>`.
> Richest section is **506-B** `4076995d-3b89-4451-957b-b2ec3712fc48` — 16 announcements (12 published, 4 drafts), 10 student-visible. Small case with a pinned row: `8a2ac745-bbd2-4848-a4b6-aeac1e69bb4b`.
> **Data gaps in the sandbox:** zero `scheduled` announcements and zero attachments anywhere, so the Scheduled badge and the attachments block are *not* observable here. Seed them before trusting those paths.

---

## Why this file exists

Two behaviors in this feature are **provably not unit-testable** and live only here:

- **push-vs-replace history semantics.** jsdom settles a router transition between clicks, so the fixed and the buggy code emit identical calls. The real defect only exists because the live URL commit trails the click by **1.5–2.4 s**.
- **the optimistic paint.** The `pendingId` tri-state is observable only *while* a transition is open, which jsdom cannot hold.

`src/__tests__/announcements-stale-selection.test.tsx` covers the one piece that *is* deterministic (clearing a `?a=` id that no longer resolves) and documents these exclusions in its header.

## A. The regression this feature exists to kill *(verified ✅)*

The measurement, not the eyeball, is the artifact. Normalise by each scroller's `scrollTop` and drive the pointer with raw `page.mouse.*` — Playwright's `hover`/`click` auto-scroll the list *and* the course `<main>`, which fakes a shift.

1. Record the **last row's** bounding-box `top`. Hover a middle row. Click three different rows. Focus a row by keyboard. Re-measure after each.
2. **Every number must be identical.** Any delta is a critical regression.

| Surface | Before (on `main`) | After |
|---|---|---|
| Professor, 16 items | hover **+119 px**; 3 open **+837 px** | **0 px** (1326.75 → 1326.75, constant) |
| Professor, 3 items | hover **+326 px** | **0 px** |
| Student, 10 items | hover **+646 px**; 3 open **+873 px** | **0 px** (884.25 constant) |

Also confirmed: no row changes height (`61.25 px` professor / `65.25 px` student, uniform), the list `scrollHeight` stays pinned, and **keyboard focus no longer expands** anything.

## B. Professor reading pane *(verified ✅)*

1. Click a row → the right pane fills with that announcement; the **list does not move**.
2. **Only the pane body scrolls.** Both scrollers carry `overscroll-contain`, so running past the end must not chain to the page and drag the list. Verify with a long body: scroll the pane to its end, keep scrolling, re-measure the first/last row.
3. The course `<main>` must have **`scrollHeight === clientHeight`** (767/767 at 1440; 691/691 at 390). It previously overflowed by 36 px (56 px at 390) because the breadcrumb sat *inside* the scroll container — that overflow is what let an overscrolled pane drag the list.
4. `?a=<uuid>` appears on select; **refresh preserves** the open announcement; a **bogus uuid** falls back to the placeholder, self-heals the URL, and does not back-trap.
5. Pane header: Pin (filled state when pinned) · Edit · Delete (separated) · **Close ✕** at `lg+`. Below `lg` the detail *replaces* the list and **All announcements** returns.
6. Read/ack counts sit in a **pinned footer** that does not scroll away. On a draft with acknowledgement/reactions/comments all off the footer must be **absent** — an unconditional wrapper used to render an orphan hairline plus empty padding.
7. A body-less announcement reads "This announcement has no body text." (not blank).

## C. Selection feedback and history *(verified ✅ / ⚠️ see note)*

1. **Optimistic paint:** the pane title and `aria-current` must flip to the clicked row **within ~150 ms** (measured 60/89/153/183/203 ms), and must *never* show the previously-selected announcement. Reading `?a=` alone left a stale pane for the whole 0.7–6 s round-trip.
2. Rapid-click 5 rows: the pane must settle on the **last** clicked row.
3. **History:** every selection `push`es (one entry per announcement opened). This is deliberate — because the URL commit lags the click, conditionally `replace`-ing cannot know whether the first push has landed, and replacing too early overwrites the *bare-list* entry, leaving nothing to go Back to. The **Close ✕**, not Back, is the primary exit.
4. Pin shows `Pinning…` → `Pinned to top`; the list re-sorts a beat later.

## D. Student list *(verified ✅)*

1. Rows are fixed-height single links: unread dot · Star/Pin/ack glyphs · `New` badge (<48 h) · title · one-line preview · date · chevron. **Nothing expands** on hover, tap, or focus.
2. Row → the existing detail page, where reactions / comments / acknowledge are **real** (👍 toggled optimistically in 81 ms; `Comments (0)` composer; "I have read this"). The old list *teased* `Reactions`/`Comments` with inert `<span>`s — those are gone.
3. **Mark all as read** → `Marking…` → dots clear → toast, with no layout shift.
4. Back → list geometry unchanged.

## E. List chrome *(verified ✅)*

1. Search + the All/Published/Drafts/Scheduled toggles + the summary live **inside the left column**, so they size to it and disappear with it when the pane takes over below `lg`. (They were page-wide, which stretched the search box to ~900 px to filter a 384 px column, and left ~250 px of chrome above the announcement on a phone.)
2. Filtered-to-zero names the cause and offers the exit: `No announcements match "<term>".` vs `No <filter> announcements.`, plus **Clear filters**.
3. Selected row must read **louder than a hovered** row. Hover previously won (`--primary` and `--ring` are the same token, and hover added a shadow the selected state lacked).

## F. Accessibility *(verified ✅)*

1. **2 tab stops per professor row** (the row, then `⋯`) — not 5. The row's accessible name is an explicit short label (`"Draft, No Classes Next Week"`, 26–53 chars), **not** the ~1000-char body; decorative glyphs are `aria-hidden`.
2. Focus ring is the house inset ring following the card radius, not the square UA outline.
3. `⋯` is 36×36, visible at rest (~3.3:1), and **not hover-gated** — on `main` a professor on a phone could not pin, edit, or delete at all (`opacity:0; pointer-events:none`).

## G. Security regression check *(verified ✅)*

`linkSchema.url` now requires `http(s)://`, and both render sinks guard with `isHttpUrl`. Verify the authoring flow still works: add `https://example.com` → saves; change to `notaurl.com` → rejected with "Link must start with http:// or https://"; restore → saves and renders as a pill. Announcements authored before the guard still render (non-http links are simply dropped, not executed).

## H. Shared-layout regression sweep *(verified ✅ — 10 pages × 2 viewports)*

`professor/courses/[sectionId]/layout.tsx` moved the breadcrumb **out** of the scrolling `<main>`, which affects **every professor course page**. Sweep course home, modules, grades, quizzes, assignments, roadmap (`h-full`), discussions (fixed two-pane), settings, enrollment. For each: breadcrumb visible, content **reaches its bottom**, horizontal padding still 24 px. A page that can no longer scroll to its bottom is critical.

---

## Driver notes (learned the hard way)

- **Playwright MCP shares one Chrome profile** across parallel servers and they steal each other's page (`Browser is already in use` / `Target page … has been closed`). `browser_run_code_unsafe` doesn't dodge it — it acquires the contended browser first. Reliable path: drive the repo's own playwright from Node with `chromium.launch({ channel: 'chrome', headless: true })`.
- **Playwright auto-scrolls before `.click()`**, corrupting viewport-relative `rect.top`. Click via in-page `el.click()` and/or normalise by `scroller.scrollTop`. `document.querySelector('main.overflow-y-auto')` returns the *outer* main — walk up from a row to find the real scroller.
- On a cold dev server the login form is un-hydrated: `fill()` submits an empty identifier. Use `pressSequentially`, read back `inputValue()`, retry.
- The course rail is icon-only — match sidebar links by `aria-label`/`href`, never `textContent`. `ToggleGroupItem` is not `role=button`; target `[aria-label="Scheduled announcements"]`.
- Ambient, **not** announcements bugs: TipTap `SSR has been detected` from the dialog editor, and one `unexpected response was received from the server` immediately after each login redirect.
- Two dev servers on 3000/3001 is a real hazard here — confirm which build owns the port before measuring: `lsof -nP -iTCP:3000 -sTCP:LISTEN -t` then `lsof -a -p <pid> -d cwd`.
