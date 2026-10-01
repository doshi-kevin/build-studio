# Professor grading queue card — per-assignment list + sort — browser walkthrough

**Target:** local dev (`localhost:3000`) + local Supabase.
**Driver:** Chrome DevTools MCP (see [README.md](./README.md)).
**Build under test:** branch `feature/professor-grading-queue` — the dashboard's grading-queue
card was a single aggregate ("23 pieces waiting, oldest 9 days, Start grading →") across every
course. It is now a scrollable list of one row **per assignment**, each linking to that
assignment's grading tab, ordered by a header dropdown.

> ⚠️ **PARTIALLY CONFIRMED — mostly still procedure.** The card was eyeballed on
> `feature/professor-grading-queue` at the author's own screen and default panel split, with the
> queue seeded by `seed-grading-queue.sh`: it renders, the rows and header read correctly, and
> nothing is visibly broken. That is a sighted spot-check, **not** this procedure. No step below
> has been measured, no width was read off the DOM, and no drag, keyboard or second viewport was
> exercised. Treat every ✅-able claim as still open until someone runs it and fills in §Run log.

> Fixtures: professor `professor@scholera.dev` / `<password in .env.local>`.
> Seed the queue with `bash scripts/dev-setup/seed-grading-queue.sh` — it creates ungraded
> submissions across every published assignment, deliberately inverted so the two sort orders
> disagree (biggest pile is newest, smallest pile is oldest). It prints the two expected orders;
> keep that output, it's the oracle for section C. It is additive-only, so an assignment that
> already had a submission may hold more than the script claims.

---

## Why this file exists

Everything in this card that unit tests **cannot** reach is a container query. The card sits in
a nested `react-resizable-panels` group and styles itself with `@container` / `@max-[Npx]:`
rather than viewport breakpoints — **jsdom cannot evaluate container queries at all**, so every
width-dependent branch below is unverifiable in Vitest by construction.

`src/__tests__/grading-queue-card-states.test.tsx` covers what *is* deterministic (error beats
empty, the sort control is absent when empty, the dropdown is wired to the list) and says so in
its header. `src/__tests__/professor-todos.test.ts` covers the grouping and both sort orders.

## A. The width claims — the whole reason this file exists

The card's header cannot fit an icon, a title, a total **and** a sort control at the dashboard's
default split. The intended order of sacrifice is icon → total, with the **title and the sort
control never giving way**. That was arrived at arithmetically and has never been eyeballed:

```
1440 viewport − 240 sidebar (lg:w-60) − 64 main padding (lg:p-8) = 1136 content
rail 40% ≈ 454 → −12 (pl-3) = 442 → grading panel 55% ≈ 243 → −6 (pr-1.5) ≈ 237px container
```

Measure the card's `<section>` (the `@container`) with `evaluate_script`, don't estimate it.

1. At **1440×900**, confirm the container is **~237px**. If it isn't, every threshold below is
   mis-tuned and should be re-derived before anything else is judged.
2. At that width: the clipboard icon is **hidden** (`@max-[250px]`), the header total is
   **hidden** (`@max-[285px]`), and **"Grading queue" is fully legible, not truncated**. The
   title truncating here is the Major regression this tuning exists to prevent.
3. Drag the handle between the grading card and Quick actions to its widest (~70%, capped by
   Quick actions' `minSize={30}`). The total should appear; the icon should already be back.
4. Drag it to its narrowest (`minSize={26}`, ~109px container). **The sort trigger must remain
   visible.** An earlier build clipped it out of sight while it stayed tab-reachable — an
   invisible focusable control. Tab through the header and confirm focus never lands on
   something you cannot see.
5. At **1920×1080** the container is ~342px, so icon + title + total + trigger should all show.
6. Below `xl` (try **1100px**) the rail stacks into one column and the card gets a fixed
   `h-96`. Confirm the list still scrolls inside it and the header doesn't wrap.

## B. Rows are per-assignment, and say which course

1. Seed, then open `/dashboard` as the professor. Expect **one row per assignment** with
   ungraded work — count them against the script's output. Fewer rows than assignments means
   the grouping regressed to per-course, which is the bug this rework exists to fix.
2. Two assignments in the **same** course must produce **two rows**, each with that course's
   code. This is the case the old per-course version collapsed into one row that could only
   link to the gradebook.
3. Every row shows a course code. Rows are per-assignment and titles repeat across courses
   ("Problem Set 4"), so a code-less row is ambiguous about which class it belongs to.
4. Click a row → lands on `/professor/courses/<id>/assignments/<id>?tab=grading`, a **grading
   screen, not a gradebook**. Check a course that has several ungraded assignments; that's
   where the old code fell back to `/grades?tab=assignments`.
5. Grade one submission, return to the dashboard: the row's count drops, or the row disappears
   when it was the last one.

## C. Sorting

1. The header trigger reads **"Oldest"** on load, and the list's top row matches the seed
   script's expected-Oldest order.
2. Open it — a two-option menu, "Longest wait first" / "Most waiting first", with the current
   one marked. Choose *Most waiting first*.
3. The list reorders to the script's expected-Most order, and the **trigger label changes to
   "Most"** (it doubles as the current-state readout).
4. The two orders must **differ**. Identical orders mean the sort isn't wired — though note the
   seed's inversion only holds for assignments it fully created (see the fixtures note).
5. Keyboard only: Tab to the trigger, `Enter` to open, arrows between options, `Enter` to
   choose. Confirm a screen reader announces the checked option.
6. Focus a row, change the sort, and confirm focus **follows that row** to its new position
   (rows are keyed by assignment id, so React should move the node rather than recreate it).

## D. Ages and colour

1. `URGENT_DAYS = 7` — only rows at **7 days or more** should be red
   (`text-destructive-muted-foreground`). 3–6 days is bold-but-neutral, under 3 days is muted.
   The point of the three tiers: every row here is a grading row, so a 3-day threshold tinted
   the whole card and red stopped meaning anything.
2. A row with everything submitted today reads **"New"**, not "0d".
3. Under *Most waiting first*, find a 7-day-plus row sitting mid-list and confirm the red still
   makes it findable — that's the only case where the colour beats position.
4. The age sits at a **consistent right edge** on every row regardless of title length. That
   alignment is what makes the ages a scannable column; losing it is a regression.

## E. Empty and error states

1. A professor with nothing ungraded: green check, "Nothing waiting to be graded", and **no
   sort control** (a control that reorders nothing reads as broken).
2. Narrow that state below ~240px — icon and text should stack and centre, and below ~200px the
   second line drops.
3. Force a failure (block the request, or point the query at a bad table) and confirm the card
   shows **"Couldn't load your grading queue"** with a warning triangle — **never** "Nothing
   waiting to be graded", and never a zero. A confident all-caught-up on a broken fetch is how
   a professor misses a week of grading. Narrow it too; the error state should now stack
   exactly like the empty one.

## F. Panel-size persistence

The split's `autoSaveId` was bumped to `professor-dashboard-toprow-v2` because
`react-resizable-panels` persists sizes to `localStorage` — without the bump, anyone who had
already loaded the dashboard would keep the old 42/58 split and never see the wider card.

1. With a **clean** `localStorage`, the grading card should get 55% of the rail's top row.
2. Drag it, reload → your size persists.
3. Write a stale `professor-dashboard-toprow` key, reload → it must be **ignored** in favour of
   the new default.

## Run log

_(empty — no run has been performed yet)_
