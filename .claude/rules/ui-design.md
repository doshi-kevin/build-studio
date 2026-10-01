---
paths:
  - "src/components/**/*.tsx"
  - "src/components/**/*.jsx"
  - "src/app/**/*.tsx"
  - "src/app/**/*.jsx"
  - "src/app/**/*.css"
---

# UI Design Rules

Extracted from "Refactoring UI" by Adam Wathan (Tailwind CSS creator) & Steve Schoger. Apply these when writing or modifying frontend components.

## Visual Hierarchy

**Use three text colors to establish hierarchy:**
- Dark (near-black) for primary content — headings, key values, names
- Medium grey for secondary content — descriptions, metadata, timestamps
- Light grey for tertiary content — captions, footnotes, placeholders

**Use two font weights, not five:**
- Normal (400 or 500) for most text
- Bold (600 or 700) for emphasis
- Stay away from font-weight below 400 for UI text — it's hard to read at small sizes. To de-emphasize text, use a lighter color or smaller size instead.

**Don't rely on font size alone for hierarchy.** Making primary content bigger and secondary content smaller often leads to primary being too large and secondary too small. Instead, make the primary bolder or darker, and the secondary lighter in color — both can stay at reasonable sizes.

**Don't use grey text on colored backgrounds.** Grey on white works because it reduces contrast. On a colored background, grey just looks dull and conflicts with the hue. Instead, hand-pick a new color with the same hue as the background and adjust saturation/lightness. Never use white text with reduced opacity — it looks washed out and shows through on images/patterns.

**Emphasize by de-emphasizing.** When the primary element doesn't pop enough and you can't make it louder, soften the competing elements instead. Give inactive nav items a softer color. Remove background color from a sidebar competing with the main content area.

**Labels are a last resort.** If the data format is self-explanatory (email addresses, phone numbers, prices), omit the label entirely. When labels are needed, de-emphasize them (smaller, lighter, uppercase tracking-wide) — the data itself is what the user cares about. Combine labels with values: "12 left in stock" is better than "In stock: 12". "3 Bedrooms" beats "Bedrooms: 3".

**Separate visual hierarchy from document hierarchy.** An `h1` tag on a page title like "Manage Account" doesn't need to be 24px+ just because it's an h1. In application UIs, page titles are often secondary to the content below them — style for visual importance, not semantic markup.

**Semantics are secondary to clarity.** Sometimes making an `h3` larger than an `h2` makes sense visually. Don't let HTML hierarchy dictate visual hierarchy — use CSS to override defaults.

## Layout & Spacing

**Start with too much white space, then remove.** Developers instinctively add just enough padding to not look broken. The result is cramped. Start with way too much space, then remove it until it's right. White space should be removed, not added.

**Dense UIs have their place.** Dashboards and data-heavy screens where information needs to be visible at a glance can be compact. Make density a deliberate choice, not a default.

**Use a constrained spacing/sizing scale.** Never pick arbitrary pixel values. Use a system where adjacent values are at least 25% apart:
- Scale: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 640, 768
- In Tailwind: use the default spacing scale. No arbitrary values like `p-[13px]` or `mt-[7px]`.
- At small sizes (icon padding, button insets), a few pixels make a big difference. At large sizes (section spacing, card widths), even 20px is barely noticeable.

**You don't have to fill the whole screen.** A 600px-wide form on a 1400px screen is fine — don't stretch it to fill. Give elements the width they need. Use max-w-sm, max-w-md, max-w-lg instead of stretching everything to full width. This applies to individual sections too — not everything needs to match the nav width.

**Not all elements should be fluid.** Sidebars, avatars, icons, and form inputs often work better with fixed widths than percentage-based widths. Fluid percentages don't scale well — a sidebar that's 25% of 1200px is fine, but 25% of 400px is unusable.

**Avoid ambiguous spacing.** When a section heading has equal space above and below it, it's unclear which section it belongs to. Always put more space above a heading than below it so it clearly associates with its content.

**Think in columns when it feels wrong as a single column.** If a narrow form looks weird stretched wide, don't make it wider — put the supporting content in a parallel column instead.

## Typography

**Define a type scale and stick to it.** Use a hand-crafted set of sizes that works well together. Recommended: 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72px. In Tailwind: text-xs through text-6xl. Never arbitrary sizes.

**Line-height is proportional to line length AND inversely proportional to font size:**
- Narrow columns (~45 chars): line-height 1.5
- Wide columns (~75 chars): line-height 1.75-2.0
- Large headlines: line-height 1.0-1.25 (they don't need extra spacing — your eye can find the next line easily)
- Small body text: line-height 1.75+ (needs more help finding the next line)

**Keep line length between 45-75 characters.** Use max-w-prose or 20-35em. Lines wider than 75 characters cause readers to lose their place. Even when the content area is wider, constrain paragraph widths separately.

**Baseline-align mixed font sizes.** When a heading and a smaller action link sit on the same line, use `items-baseline` not `items-center`. Baseline alignment uses the natural line that letters rest on, producing a cleaner look.

**Not every link needs a color.** In link-heavy UIs (navigation bars, card lists, table rows), using colored/underlined links makes everything scream for attention. Use font-weight or darker color instead. Reserve the classic blue-underline treatment for inline links within body text paragraphs.

**Left-align everything by default.** Only center-align short, independent blocks (hero headings, feature card titles, single-line descriptions). Anything longer than 2-3 lines should be left-aligned. If centered text blocks have uneven lengths, rewrite the content to match rather than left-aligning just one.

**Right-align numbers in tables.** When decimals and digits align vertically, columns are much easier to scan. Use `tabular-nums` (Tailwind: `tabular-nums`) for table number columns.

**Add letter-spacing to all-caps text.** Use `tracking-wide` or `tracking-wider` in Tailwind. All-caps letters are uniform in height and lack the visual diversity of mixed case, so wider spacing improves readability.

**Avoid em units.** Em compounds in nested elements (1.25em inside 1.25em = 1.5625em = not on your scale). Use px or rem to guarantee values stay on your type scale.

## Color

**Use HSL or OKLCH, not hex.** Hex values like #3B82F6 convey nothing about the color relationship. HSL (hue, saturation, lightness) maps to how humans perceive color, making shade adjustments intuitive.

**Build a full shade palette upfront (8-10 shades per color, labeled 100-900):**
- Pick the base shade (500) — should work as a button background
- Pick the darkest (900) — for text on light backgrounds
- Pick the lightest (100) — for tinted backgrounds (alert panels, badges)
- Fill in between by splitting gaps evenly (700 between 900 and 500, then 300 between 500 and 100, then fill remaining slots)
- You need: a full grey scale, a primary color scale, and accent scales for success (green), warning (yellow), danger (red)

**Don't let lightness kill saturation.** At 50% lightness, saturation is most visible. As lightness moves toward 0% or 100%, the same saturation value looks duller. Compensate by increasing saturation for very light and very dark shades. For even richer palettes, rotate the hue slightly: lighter shades rotate toward nearest bright hue (60/180/300), darker shades rotate toward nearest dark hue (0/120/240).

**Greys don't have to be pure grey.** A grey scale with a slight cool (blue) or warm (yellow/brown) tint looks more polished than mathematically neutral grey. Match the temperature to your brand.

**True black looks unnatural.** Start your darkest grey at something like hsl(220, 15%, 10%) rather than #000000. It's softer and more refined.

**Don't rely on color alone.** Always pair color coding with a second signal — an icon, a text label, a pattern, or a border. Red border + red text + warning icon. Green badge + checkmark icon. This is essential for accessibility but also makes the UI clearer for everyone.

## Depth & Shadows

**Use shadows to represent elevation on a virtual z-axis, not as decoration:**
- Level 1 (buttons, form inputs): `shadow-sm` — barely raised, subtle
- Level 2 (cards, panels): `shadow` — slightly raised off background
- Level 3 (dropdowns, popovers): `shadow-md` — clearly floating above the page
- Level 4 (sticky headers, drawers): `shadow-lg` — high above the page
- Level 5 (modals, dialogs): `shadow-xl` — maximum elevation, demands attention

Define your shadow levels and use them consistently. Don't invent new shadows per component — pick the elevation level it belongs to.

**Combine two shadows for realism.** Use one large/soft shadow (direct light, large blur, slight opacity) and one small/tight shadow (ambient shadow directly underneath, small blur, slightly higher opacity). Together they look far more natural than a single shadow.

**Use shadows for interaction feedback.** On hover, increase shadow (element lifts toward user). On click/active, decrease shadow (element presses into page). This gives buttons and cards a tactile quality.

**Even flat designs create depth.** Without any shadows, you can still convey depth using lighter/darker background fills. A slightly off-white content area on a white page reads as "raised." Solid color backgrounds in alternating sections create visual layers.

## Empty States

**The empty state is the user's first impression of a feature — design it, don't ignore it.** Never show just "No items found" or a blank area. Include:
- An illustration or icon
- A brief explanation of what this area will contain
- A prominent CTA to take the first action ("Create your first quiz", "Add a module")

**Hide irrelevant UI in empty states.** Tabs, filters, search bars, and sorting controls don't help when there's no content. Show them only after the user has created at least one item. This makes the empty state feel intentional, not broken.

## Friendly Abstractions & Error Handling

The UI is a layer that hides the system from the user. Across every surface — flows, forms, lists, dialogs, individual controls — show people their task and their outcome, never the machinery underneath.

**Hide the machinery; expose the task.** Whatever the work is — multi-step pipelines, async jobs, data assembly, API orchestration — the user should experience one clear thing to do and one clear result. Collapse technical steps into the smallest interaction that gets the job done; don't expose intermediate state, internal config, or system nouns the user doesn't need. (A "Copy AI Instructions" button that assembles and copies a payload in one click is one instance of this; the same principle shapes how you structure a whole flow or page.)

**Speak the user's language, not the system's.** Labels, headings, empty/loading/success copy, field names — phrase by what the user wants or gets, not by the underlying function, table, or implementation. If any piece of UI needs a tooltip or docs to be understood, the wording or the design is wrong.

**Show users what to do, not what broke.** Never surface raw errors — stack traces, status codes, Supabase/Postgres messages, exception text — anywhere in the UI. Translate every failure into a calm, plain-language message that says what happened and the next step ("Couldn't save your changes — check your connection and try again"), with a retry or recovery path where one exists. Log the technical detail via `logger`; keep it out of the user's face. Handle the unhappy paths (empty, partial, offline, permission-denied, timeout) as deliberately as the happy one.

**Make state legible at every step.** Give immediate, visible feedback for what's happening — loading/disabled states during work, progress for long operations, and clear confirmation on success — so the user always knows the system heard them and whether it worked, without needing to understand how.

**Design the structure to do the abstracting.** Sometimes the right answer isn't copy or a control but layout: group related actions, sequence a complex task into digestible steps, default the sensible choice, and reveal advanced options progressively. Let the arrangement of the UI carry the simplicity, not just the words on it.

## Borders & Separation

**Reach for borders last, not first.** When you need to separate two elements, try these alternatives before adding a border:
1. **Box shadow:** a subtle shadow on one of the elements creates natural separation
2. **Different background colors:** even a slight shade difference (white on off-white) separates without a line
3. **Extra spacing:** more padding/margin between elements is often enough

**When you do use borders, keep them subtle.** Light grey, 1px. A heavy border competes with the content it's supposed to frame.

## Finishing Touches

**Replace defaults with richer elements.** Swap bullet points for icons (checkmarks, colored dots). Swap plain links for styled ones (bold weight, custom underline). Replace browser-default checkboxes/radio buttons with custom styled components using brand colors.

**Add accent borders for visual interest.** A thin colored border along the top of a card, the left side of an alert, or underneath a headline adds polish without requiring graphic design skills. Use your primary or accent color.

**Don't overlook user-uploaded content.** Layouts tested with perfect sample data break with real user content. Always consider: very long names, missing avatars, empty descriptions, oversized images. Build for the messy real world, not the clean demo.

## Staying On-Theme

**IMPORTANT: Never use raw Tailwind color classes (gray-500, blue-600, slate-300, etc.) or hardcoded hex/rgb values. Always use the semantic CSS variable classes defined in `src/app/globals.css`.**

Before creating any new component or page, read `src/app/globals.css` to understand the current design tokens — background, foreground, primary, secondary, muted, accent, destructive, border, input, ring, card, popover, chart-1 through chart-5, sidebar tokens, and the font/radius variables. These are the source of truth. They may change with redesigns.

- Use `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-card`, `bg-muted`, `border-border`, `bg-primary`, `bg-destructive`, etc.
- Use the font variables (`font-sans`, `font-serif`, `font-mono`) as defined in globals — never hardcode font family names.
- Use the `--radius` variable system for border radius — never raw pixel values. Border radius classes must be `rounded-xl`, `rounded-2xl`, `rounded-3xl`, or `rounded-full` only.
- No custom CSS files except `globals.css`.
- If a color you need doesn't exist in the current token system, flag it to the user — don't invent a new raw color.
- Match the visual tone of existing pages. When in doubt, read an existing sibling page's source to see which tokens it uses.

Source: "Refactoring UI" by Adam Wathan & Steve Schoger
