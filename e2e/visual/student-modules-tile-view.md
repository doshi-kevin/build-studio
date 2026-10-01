# Student Modules — list ↔ tile view — browser walkthrough

**Target:** local dev (`localhost:3000`) + local Supabase.
**Driver:** Chrome DevTools MCP (see [README.md](./README.md)).
**Date written:** 2026-08-17
**Build under test:** branch `feature/student-modules-ui` — the student Modules page gains a **Tiles / List** toggle in the page header. In tile view, weeks render as cards in a responsive grid; selecting one opens a full-width detail panel **beneath that row of tiles**.

## Run log

**2026-08-18 — partial pass, by hand (no MCP driver), local dev + local Supabase.**
Student `student4@scholera.dev`, CS101 `bec3377d-1a20-5b5d-8fd0-58095a4438bc`, fixture as below (11 published modules, 2 dividers, 20 items).

| § | | |
|---|---|---|
| **B** Panel placement | ✅ | opens under the whole row; the row's other tiles hold their place |
| **C** Reflow | ✅ | panel re-attaches to the correct row across 4 → 3 → 2 → 1 columns and back |
| **E** Truncation / column split | ✅ | two columns at `xl`, one below it |
| **G** Focus | ✅ | focus moves into the panel on open and returns to the tile on Collapse |
| A, D, F, H, I | ✅ | walked by the author in the same pass; A/D/F/H are additionally covered by the unit suites (96 tests) |
| Regression sweep | ✅ | professor Modules board loaded after the shared-hook change — sections still expand/collapse independently, several open at once, first-open default intact |

**Fixture bug found and fixed during the pass** — not a product defect. Tabbing through an open panel appeared to skip most rows. Cause: the fixture seeded lecture items with filenames and page counts but **no file**, and `StudentModuleItemRow` renders a row it cannot open as a `<div>` rather than a `<button>` (deliberate — un-actionable rows must not present clickable chrome), so those rows are correctly absent from the tab order. The seed script now uploads one real PDF into the local `course-materials` bucket and points pdf-type rows at it; re-verified after. **This is the trap to remember: an all-inert fixture makes §G untestable and looks exactly like a tile-view bug.**

> Recorded by Claude from the author's report; sections B/C/E/G were stepped through together in detail, the remainder walked by the author. No screen recording was captured — re-run the pass from this file plus `scripts/dev-setup/seed-modules-tile-fixtures.sh` to see it live.

---

## Why this file exists

Three behaviours in this feature are **not unit-testable**, and the unit tests say so:

- **Where the panel lands, visually.** `src/__tests__/student-modules-tile-view.test.tsx` asserts DOM order via `compareDocumentPosition` — that the panel follows the last tile of its row. It cannot assert that the panel *looks* attached to that row, that the grid doesn't leave an ugly hole, or that the surrounding tiles don't jump.
- **Column reflow.** `useTileColumns` reads `matchMedia`. jsdom has no `matchMedia` at all (the test stubs it at a fixed width), so the resize path — crossing a breakpoint and the panel moving to a different row — has never actually run.
- **Truncation and clamping.** Two-line description clamps and long filenames in the panel's two columns are layout outcomes, invisible to jsdom.

`src/__tests__/modules-tile-layout.test.ts` covers the placement arithmetic deterministically (including the divider case); this file covers what it looks like.

## Fixture

The walkthrough needs a section with enough shape to fill a grid — **two modules is not enough to test anything here**. Required:

- ≥ 9 published modules, so a 4-column grid has more than one row
- ≥ 2 module dividers **between** modules (a divider ends the row above it, which is the case a naive `index / columns` gets wrong)
- one module with **no items** (empty tile summary + empty panel copy)
- one module with **no `week_number`** (tile has no eyebrow to align to)
- one module with **≥ 5 items** including an in-module `section_divider` item and a **very long filename**
- ≥ 2 modules with a future `unlock_date` (locked tiles)

`scripts/dev-setup/seed-modules-tile-fixtures.sh [sectionId]` builds exactly that (local dev helper; idempotent, replaces only its own rows). Accounts: `student4@scholera.dev`, password in `.env.local`. On a standard local seed the target is **CS101** — student4 is enrolled there; they are **not** on CS201, and the student section layout `notFound()`s for a non-enrolled viewer, which surfaces as the *root* 404 page ("This page isn't available"), not a course-level one.

**PDF lecture rows point at a real object** (one small PDF from the table-extraction fixtures, uploaded once into the local `course-materials` bucket), so the viewer and download work and those rows are **tab stops**. Decks, notes and dividers deliberately carry no file.

That distinction is load-bearing for §G, not cosmetic: a row with no file isn't openable, so `StudentModuleItemRow` renders it as a `<div>` rather than a `<button>` — by design, so un-actionable rows don't present clickable chrome — and it never enters the tab order. An all-inert fixture makes the panel's focus order untestable and looks like a bug in the tile view when it isn't.

---

## A. Default and persistence

1. Open Modules as a student. It must render the **list**, unchanged — a reader who never touches the toggle sees no difference. The toggle sits top-right of the header, `Tiles` then `List`.
2. Click **Tiles**. Reload the page → still tiles. Navigate to a **different course** → still tiles (the preference is global, not per course).
3. Clear `localStorage` key `scholera_modules_view` → back to list.
4. Set that key to junk (`localStorage.setItem('scholera_modules_view','grid')`) and reload → list, no crash.

## B. Where the panel opens — the core behaviour

At a wide viewport (≥1280 px → 4 columns) with the fixture above, the visual row structure should be: a row of tiles cut short by *Unit 1*, then a row of 3 cut short by *Unit 2*, then a row of 4, then the remainder.

1. Click the **2nd tile of a 4-tile row**. The panel must open **below all four tiles of that row** — not immediately under the clicked tile, and not at the end of the grid. The other three tiles must **not** move.
2. Click a tile in the **row after a divider**. Confirm the divider still spans the full width and that the row it heads is the row the panel attaches to.
3. Click a tile in the **last, short row**. The panel opens under it with nothing following.
4. Confirm the selected tile is visibly marked (border + ring, chevron rotated) and that **only one panel** is open at any time.
5. Click the selected tile again → panel closes. Re-open, click **Collapse** → panel closes.

## C. Reflow *(the path jsdom has never run)*

1. With a panel open, drag the window narrower across **1280 → 1024 → 640 px**. At each breakpoint the column count changes (4 → 3 → 2 → 1) and the panel must **re-attach to the row that now holds the selected tile**. A panel stranded mid-grid, or under the wrong row, is a failure.
2. Widen back. Same check in reverse.
3. At the narrowest width (1 column) the panel sits directly under its own tile — correct, not a bug.

## D. Tile content and edge cases

1. **Empty module** ("Model Evaluation"): tile summary reads `Empty`; opening it shows the "instructor hasn't added anything here yet" copy, not a blank panel.
2. **No week number** ("Supplementary Readings"): the tile has no eyebrow. Its title must still align with tiles that do — the eyebrow row is reserved.
3. **Long description**: clamps to 2 lines on the tile, shows in full in the panel.
4. **Locked weeks**: dimmed, dashed border, `Lock` glyph, `WEEK n · LOCKED` eyebrow, `Opens <date>` footer. It must have **no hover affordance and no focus stop** — it is a `div`, not a button. Confirm none of its item titles appear anywhere in the DOM (the page never fetches them).
5. Tiles in a row must be **equal height** regardless of description length, with the contents summary pinned to the bottom.

## E. The panel

1. Materials render in **two columns**. Check the long filename (`Mod03-Lifecycle_dataprocessing_full_annotated_v3_FINAL.pdf`) — decide whether truncation there is acceptable or whether this should be one column. **This is the open design question in §8 of the design doc.**
2. An in-module `section_divider` item spans **both** columns and carries no card chrome.
3. Type colours/icons match the list view for the same items.

## F. Search falls back to the list *(deliberate — see design doc §4)*

1. In tile view, type into the search box. The layout switches to the **list**, showing matching weeks force-opened. The `Tiles` button stays selected.
2. Clear the search → the grid returns, with the same tile selected as before.
3. Judge whether the toggle looking "ignored" during search reads as broken. If it does, that's the argument for the disabled-toggle variant that was considered and rejected.

## G. Accessibility

1. The tile is a `<button>` with `aria-expanded` and, when open, `aria-controls` pointing at the panel; the panel is `role="region"` `aria-labelledby` pointing back at the tile. Confirm a screen reader announces the relationship sensibly **given the panel is a sibling, not a child** — this is the part most likely to need changing.
2. Tab order: tiles in visual order, then the panel's contents when open. Confirm opening a panel doesn't strand focus, and that closing returns focus to the tile.
   **What a correct order looks like** — a row with a file contributes three stops (the row itself, Open, Download); a video or link row contributes one; a deck with no upload, a note, and a section divider contribute **none**, because they aren't actionable. Rows being skipped is therefore the expected result, not a defect — check it against the fixture's `openable` column rather than counting rows on screen.
3. Selected state must not rely on colour alone (the chevron rotation is the second signal — verify it's actually perceptible).
4. Focus ring on tiles follows the card radius.

## H. Deep links still work in tile view *(shared expansion state)*

1. Open `?section=<moduleId>` in tile view → that week is selected, its panel open, scrolled into view.
2. Open a citation link `?item=<itemId>&page=N` → the owning week's panel opens and the item pulses.
3. A link naming a **locked** week must not select it.
4. Switch to list → the same week is still open (one shared expansion state).

## I. Mobile

1. At 390 px: one column, panel under its tile, header toggle still reachable and not wrapping awkwardly.
2. Tap targets on the tile and the toggle meet the 44 px floor.

---

## Regression sweep

`src/lib/hooks/use-module-expansion.ts` is **shared with the professor Modules board**. It gained `setOnly` and `usingDefault`; the professor board destructures neither. Load the professor board and confirm: sections still collapse/expand independently, several can be open at once, and the first section still auto-opens on a first visit.
