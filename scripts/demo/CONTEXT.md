# Demo seed — CONTEXT

Read this before changing anything in `scripts/demo/`.

## What this is

One command that builds a complete, believable university inside Scholera for a client
demo. It creates a single isolated tenant — **Northcrest University** — with one course,
three sections, three professors, two dozen students, and a semester that is already nine
weeks old.

```bash
bash scripts/demo/seed-demo.sh --local            # create, or refresh in place, against local Supabase
bash scripts/demo/seed-demo.sh --prod             # same, against production (see Safety below)
bash scripts/demo/seed-demo.sh --local --reset    # delete the tenant, then rebuild it
```

## How it differs from `scripts/dev-setup/seed-dev.ts`

They look similar and they are not interchangeable.

| | `dev-setup/seed-dev.ts` | `demo/seed-demo.ts` |
|---|---|---|
| Audience | Junior engineers, local only | Clients, on a deployed app |
| Tenant | Scholera Dev | Northcrest University |
| Bar it has to clear | Valid against the schema | Convincing to someone paying |
| Data | Two courses, one quiz, a few rows | A term in progress across every feature |
| Targets | Local and staging | Local and production, prod behind a typed confirm |

Do not merge them. The dev seed stays small on purpose: it runs after every `db reset`, and
a slow seed makes the intern loop worse.

## The one rule that keeps it believable

**Every score in the tenant derives from one latent `ability` number per student.**
`assessments.ts` rolls it once, and quiz results, assignment scores, skill mastery, live-class
poll answers, and the insight summaries all read from it. This is not a stylistic
preference. The fastest way to lose a demo is a screen where the gradebook calls a student
strong and the mastery heatmap calls them at risk, and independent random numbers produce
that contradiction within about three clicks.

The same principle covers computed data:

- **Live-classroom reports are not hand-written JSON.** `classroom.ts` calls the app's own
  `computeSessionStats()` and `computeStudentInsights()` on the rows it just inserted. The
  report therefore cannot disagree with the attendance list and poll results beside it.
- **`quiz_item_stats` is tallied from the answers actually written**, not invented.
- **`assignments.settings.publishedStats`** (the n / average / median / histogram a student
  sees) is computed from the submissions actually written.
- **Insight summary `facts`** are computed from the mastery and quiz maps the assessments
  layer returns.

If you add a feature here, follow the same rule: derive, do not roll.

**Submission write-ups derive from the rubric ticks.** The same rule, one level
below scores. `WRITEUPS` in `assessments.ts` holds one passage per rubric criterion,
keyed by the `${groupIndex}:${criterionIndex}` string that `rubric_scores` already
uses, in two versions: `earned` and `thin`. `buildWriteup()` renders whichever the
student's own tick list calls for, so a submission whose rubric shows "Reports the
base rate alongside the score" unticked has a results section that genuinely never
mentions the base rate. `buildRubricComments()` reads the same set and writes the
grader's note onto exactly the rubric cards where a point was lost.

The document and the rubric panel next to it are therefore one decision rendered
twice, not two guesses that have to be kept in step. Before this, the PDF was a
single sentence — the same sentence as `text_content` — so the grader opened a
submission and read the same line in both panes, which was the most obviously
fabricated screen in the tenant.

Two places have no ticks to read: the open assignment (nothing is graded yet) and
sections B and C (no rubric at all). Both call `earnedByAbility()`, which takes
`round(frac * n)` criteria and picks WHICH by a seeded shuffle. Do not replace that
with an independent draw per criterion — see "Why the in-class quiz has four
questions" below for what independent flips do to a short list.

## The clock

Two anchors in `context.ts` drive every date:

```
TERM_START = today − 9 weeks      (DEMO_WEEKS_ELAPSED)
TERM_END   = TERM_START + 15 weeks (DEMO_TERM_WEEKS)
```

So the tenant reads as mid-semester whenever it is run, without editing anything. The
semester label (`spring` / `summer` / `fall` / `winter`) comes from the term's **midpoint**,
not its start, so a term straddling two seasons gets the one it mostly sits in.

Past live classes are anchored to the section's real meeting weekdays via `onWeekday()`.
Subtracting a flat seven days would put every past session on today's weekday, which
contradicts the schedule shown next to it.

Overrides: `DEMO_NOW`, `DEMO_TERM_START`, `DEMO_WEEKS_ELAPSED`, `DEMO_TERM_WEEKS`,
`DEMO_PASSWORD`.

## Layout

| File | What it seeds |
|---|---|
| `seed-demo.sh` | Preflight, environment, target confirmation, `--reset` confirmation |
| `seed-demo.ts` | Orchestration, the reset routine, the row-count summary |
| `parts/context.ts` | Target gate, admin client, deterministic ids, term clock, `up()` |
| `parts/curriculum.ts` | Fifteen weeks of course content: topics, slides, transcripts, skills |
| `parts/roster.ts` | Institution, department, program, people, course, sections, enrolments, staff |
| `parts/content.ts` | Modules and materials, skill tree, announcements, roadmap, ABET, catalog |
| `parts/assessments.ts` | Quizzes, assignments, gradebook, skill mastery |
| `parts/collab.ts` | Team project, discussions, DMs, challenges, certificates, calendars |
| `parts/classroom.ts` | Live classroom sessions, decks, transcripts, reports |
| `parts/ai.ts` | Athena, tutor history, memory, insight summaries, feed, telemetry |
| `parts/files.ts` | PDF generation, Storage upload, slide rasterisation, prefix delete |
| `verify-render.ts` | Read-only check that every deck page, handout and submission PDF really rendered |
| `backfill-embeddings.ts` | One-time: indexes the lecture handouts into Pinecone (not run by `seed-demo.ts`) |
| `backfill-primers.ts` | One-time: generates each lecture's pre-class primer audio (not run by `seed-demo.ts`) |
| `.env.demo.local(.example)` | `--local` fallback when no live local Supabase stack is detected — gitignored |
| `.env.demo.prod(.example)` | `--prod`'s only source of credentials — gitignored, never the shared repo-root `.env.local` |
| `tsconfig.json` | `@/*` alias plus the `server-only` stub, so the seed can import app code |

Section A is seeded to full depth. B and C get enrolments, modules and one graded
assignment each — no quizzes. That is deliberate: three full sections triple the runtime and show
nothing extra, and uneven adoption across sections is what a real campus looks like.
**Demo from section A.**

## Safety

- **No implicit target.** `seed-demo.sh` requires one of `--local`, `--prod`, or `--env
  <file>` — there is no default, so it can never silently resolve to whatever happened to
  be lying around. `--local` and `--prod` each read their own dedicated, gitignored file
  (`scripts/demo/.env.demo.local`, `scripts/demo/.env.demo.prod`) — never the shared
  repo-root `.env.local`, which also drives `npm run dev` and gets toggled between local
  and production values for unrelated reasons. If the resolved URL doesn't match the flag
  (`--prod` resolving to localhost, or `--local` resolving to something remote), the script
  refuses and names the mismatch rather than guessing which one you meant.
- Refuses to run unless the target is localhost, or `DEMO_CONFIRM_REF` matches the target's
  own project ref. An allowlist, so adding an environment can never silently re-enable an
  old one.
- Targeting a remote project additionally requires typing the institution name at a prompt
  in `seed-demo.sh`. This is independent of which flag you passed — it fires on the
  resolved URL, so a misconfigured `--local` that actually points somewhere remote still
  hits it.
- Aborts if the computed institution id ever collides with Stevens or Scholera Dev.
- Every tenant-scoped insert carries `institution_id` explicitly. The database has
  tenant-match triggers that reject a row whose institution disagrees with its parent.
- `--reset` only deletes rows reachable from the Northcrest institution, and only deletes
  accounts whose address ends in `@northcrest.edu`. Anything else it finds, it leaves alone
  and warns about.
- It never runs `supabase db reset`.

## Re-running

Every id is a UUID v5 under a `scholera-demo-seed` namespace, so a second run upserts the
same rows instead of duplicating them, and the logins never change. That matters more than
it sounds: a demo you can rehearse is one where the URL you bookmarked still works
tomorrow.

Tables without a surrogate key (`lc_attendance`, `lc_session_reports`, `dm_read_cursors`,
`quiz_item_stats`, `skill_mastery_snapshots`, …) pass their natural key as the conflict
target. If you add one, check its real primary key first — `skill_mastery_snapshots` is
keyed on `(student_id, skill_id, captured_on)` and **not** on `section_id`, which is the
kind of thing that only fails at runtime.

`skill_mastery` DOES have a surrogate `id`, but the seed still conflicts on
`(student_id, skill_id)` instead. The real app writes this table too (a quiz attempt
recomputes a student's mastery), so a demo student who was ever actually clicked
through in the app can already have a row for a skill under a real, non-deterministic
id. Upserting on the seed's own `id` would insert a second row and hit the table's
`(student_id, skill_id)` unique constraint; upserting on the natural key overwrites
whatever row is really there instead.

## Why the in-class quiz has four questions

Not a stylistic choice. `computeSessionStats()` flags a student `atRisk` when their
quiz accuracy is under 60%. On a two-question quiz, getting one right scores 50% and
flags them — which put 7 to 11 of 12 students on the at-risk list every week and made
the panel read as broken. Four questions give 0/25/50/75/100, so a student who knows
most of the material lands above the line.

For the same reason, per-question correctness is derived from the student's ability
(`round(ability * n)` plus small jitter) rather than an independent coin flip per
question. Independent flips give a capable student a real chance of scoring 2 of 4.
After both changes the flag lands on 2 to 4 students a week, and the same two students
are flagged in all nine sessions — which is the signal the feature exists to show.

If you add or remove questions here, re-check the at-risk counts before calling it done.

## Database hazards this script works around

- **`scheduled_publish_at` is never set.** Writing it fires an `AFTER` trigger that calls
  `cron.schedule()`, and pg_cron may not exist on the target. Scheduled-looking items carry
  a status only.
- **Live-classroom rooms are inserted straight as `ended`.** Transitioning `live → ended`
  fires realtime broadcast triggers for a class that happened two months ago.
- **The team chat channel is created before its members.** Inserting `project_members`
  fires a trigger that writes a "joined" system message into the team's default channel; if
  the channel does not exist yet, the message is silently dropped. The trigger also stamps
  the message with real `now()`, not a term-relative date, so it lands at the bottom of a
  chat history that starts weeks earlier unless you backdate it — `seedProject()` does this
  right after the `project_members` upsert (found by a red-team audit; nothing else in the
  seed writes a message with a real wall-clock timestamp).
- **`user_memory` has a quota trigger** that keeps the newest ten rows per
  (user, institution, kind, section). The seed stays well under it.
- **Constrained text columns are not free text.** `programs.degree_type` wants `bachelor`,
  not `bs`; `department_faculty.position` wants `associate_professor`, not
  `Associate Professor`; `blocked_times.reason` wants `meeting`, not `Faculty meeting`
  (the sentence goes in `note`). Check `pg_constraint` before adding a value.
- **A batch upsert must carry a uniform set of columns.** PostgREST builds one INSERT
  per request with a single column list taken from the union of the keys you give it.
  A row that omits a key another row in the same batch has is sent an explicit NULL
  rather than falling back to the column DEFAULT, which then fails any NOT NULL column.
  `up()` handles this by grouping rows by key signature, so callers can build rows
  naturally and omit what does not apply — but if you write a raw `db.upsert()`
  anywhere, this is waiting for you.
- **Never send an explicit `null` for an optional column.** Several tables use
  `NOT NULL DEFAULT ''` for optional text (`office_hours.zoom_link`,
  `bookings.location`, `blocked_times.note`). Pass `''`, or omit the key.
- **`lc_rooms` and `lc_decks` reference each other.** `lc_rooms.active_deck_id` points
  at a deck and `lc_decks.room_id` points back at the room, so rooms are inserted
  without their active deck, the decks follow, then a second pass links them.
- **Changing a row's id scheme needs a natural-key upsert.** `announcement_reactions`
  is keyed `(announcement_id, student_id, emoji)`. An earlier version of the seed gave
  its rows ids of the form `ann-react-${student}`; the current one keys them by
  announcement and emoji too. For at least one row the two schemes produce the SAME
  natural key under a DIFFERENT id, so upserting on `id` tried to INSERT a row whose
  natural key already existed and took the whole run down with a unique violation.
  It now conflicts on the natural key, and `REACTION_PLAN` is deliberately a superset
  of what the old scheme wrote so every pre-existing row is matched and updated rather
  than stranded. The same trap as `skill_mastery` above, reached from the other
  direction: there the app writes rows the seed did not, here an older seed did.
- **Local and production schemas drift.** `profiles.cwid` is in the base schema and
  present in production, but missing from at least one local stack; an open SSO branch
  drops it entirely. The seed asks the database whether the column exists
  (`columnExists()`) rather than assuming. Use that for genuinely optional fields only —
  never to paper over a column the data depends on.
- **`profiles.cwid` must be 8 digits.** The login page lets a student sign in with a
  campus id instead of an email (`resolveCwidToEmail`), so anything else makes that path
  undemonstrable. The seed uses a `77` prefix, which no real production cwid uses.

## Lecture handouts carry real extraction data, not just a real PDF

A seeded lecture's `module_items.content` has never gone through the real extraction
worker (the PDF is uploaded directly, `parts/files.ts`'s `makeHandoutPdf` — there's no
`extraction_jobs` claim-and-run in between). Two features silently degrade without
`content.extraction` populated in the exact shape the real worker writes
(`ExtractionResultData`, `src/lib/validations/document-extraction.ts`):

- **Athena's quiz generator** (`getModulesWithExtraction`,
  `professor/courses/[sectionId]/quizzes/actions.ts`) only offers a lecture as a
  generation source when `content.extraction.status === 'completed'` and
  `content.extraction.pages.length > 0` — with nothing there, it refuses outright
  ("This course has no lecture files with extracted text yet").
- **The pre-class primer generator** (`buildPrimerSource`,
  `src/lib/preclass-audio/content.ts`) falls back to the week's one-sentence blurb
  instead of the real lecture text.

`makeHandoutPdf` (`parts/files.ts`) returns `{ buffer, pages }`, not just a `Buffer` —
`pages` is built from the *exact same layout pass* that lays out the PDF, so a page
number Athena cites always matches what a student actually sees on that page in the
real file. `parts/content.ts` writes that straight into `content.extraction` (status
`completed`, real `pages`/`metadata.wordCount`) and sets `content.fileType: 'pdf'`
(also required, also previously missing). No API cost — this is real text the seed
already generated to build the PDF, just written to the field these features actually
read instead of only the field `/admin/extraction-jobs` reads.

If you add a new PDF-bearing module item, either route it through `makeHandoutPdf` and
copy this pattern, or it'll silently be invisible to both features above.

## Course-material embeddings (Pinecone)

`seed-demo.ts` itself never touches Pinecone — Athena's retrieval over the seeded lecture
handouts only works after `backfill-embeddings.ts` has been run **once, ever**, against
this tenant. This is deliberate, not a gap:

- Pinecone has one shared index across every environment (`.claude/rules/vector-db.md`
  rule 7). Northcrest's institution and section ids are deterministic (`det('institution')`
  etc.), so a vector embedded from a LOCAL run lands in the exact namespace a PRODUCTION
  run of `seed-demo.sh` will read from later. Embedding is therefore decoupled from which
  Postgres the tenant's rows currently live in.
- The course content in `parts/curriculum.ts` is static, so once a page is embedded its
  vector stays valid across every future re-run of `seed-demo.sh` — re-running the seed
  doesn't change the underlying content, and the seed doesn't touch Pinecone, so nothing
  invalidates the vectors already there.
- Net effect: run `backfill-embeddings.ts` once, before the first real demo that shows
  document retrieval. Every `seed-demo.sh` run after that — local rehearsal or the real
  production seed — demos with citations already working, at zero repeat API cost.

Run it (reuses the real production ingestion pipeline,
`src/lib/jobs/pipelines/embed-material.ts` — see the file's own header comment for why):

```bash
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
PINECONE_ALLOW_NONPROD_WRITES=true \
  npx tsx --tsconfig scripts/demo/tsconfig.json scripts/demo/backfill-embeddings.ts
```

`PINECONE_ALLOW_NONPROD_WRITES` is only needed outside `NODE_ENV=production` — see
`src/lib/pinecone/client.ts`'s `assertVectorWritesAllowed()`. It's a real write to shared
infrastructure and a real (small) API cost, so don't run it reflexively — run it once,
deliberately, ahead of when the demo will actually need it.

## Pre-class primer audio

Same shape as the embeddings backfill above: `seed-demo.ts` never generates a primer —
`backfill-primers.ts` does, **once, ever**, against this tenant.

- The lecture content in `parts/curriculum.ts` is static, so once a primer is generated its
  script and narrated audio stay valid across every future re-run of `seed-demo.sh`.
- Reuses the real generator, `src/lib/preclass-audio/generate.ts`'s `generatePrimer()` —
  exactly what runs when a student opens a lecture's primer for the first time. It resolves
  the lecture's own section/institution and checks the tenant's AI kill-switch itself, so
  no `PipelineContext`/job row is needed — simpler to call standalone than the embeddings
  pipeline. Northcrest's institution has no AI-policy override, so `preclass-ai` resolves to
  the enabled default; nothing to toggle before running.
- Every seeded lecture item carries a real week-specific `description` (`curriculum.ts`'s
  `blurb`), which is enough on its own for `buildPrimerSource()`'s `hasMaterial` check to
  pass even though the seed's PDFs were never run through the real extraction pipeline (no
  `content.extraction.pages` — that's `extraction_jobs`, seeded separately, see above). The
  primer script is grounded in the module/lecture blurbs and the previous lecture's blurb
  for the bridge, not the PDF body text.

Run it (needs `GOOGLE_GENERATIVE_AI_API_KEY` and `ELEVENLABS_API_KEY` in the shell):

```bash
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
GOOGLE_GENERATIVE_AI_API_KEY=... ELEVENLABS_API_KEY=... \
  npx tsx --tsconfig scripts/demo/tsconfig.json scripts/demo/backfill-primers.ts
```

Two real external API calls per lecture (Gemini for the script, ElevenLabs for the
narration) — small but nonzero cost per lecture, same category as the embeddings backfill.
Run it once, deliberately, ahead of when the demo will actually need it.

## What is deliberately NOT seeded

Stated up front so nobody discovers it mid-demo:

- **Ops ledgers — three of the four tables.** `ai_usage_events` and `external_usage_events`
  are readable only from `/super-admin/cost-analysis`, a Scholera-internal role no
  Northcrest login can reach — seeding them would be invisible in any demo. `background_jobs`
  has one demo-visible consumer, an ABET "last computed" chip, but ABET data is seeded
  directly in `content.ts` without ever going through this queue, so the chip has nothing to
  show either way. `extraction_jobs` — the fourth table — IS seeded (see below); it has a
  real admin-reachable page.
- **GitHub integration**: `github_connections`, `project_repositories`, `project_commits`.
  These need a real GitHub app installation.

## Slide images

Decks are generated as real PDFs with jsPDF, uploaded to `live-classroom-decks`, and then
rasterised page by page with the app's own `renderPdfPages()` into
`{roomId}/{deckId}/{version}/page-N.webp` — the exact layout the deck viewer reads.

This is best-effort. If pdfjs or the canvas binding fails on a given machine, the deck row
is written without `deck_url`, the run prints a warning and carries on. A demo missing
slide images is a much smaller problem than a seed that dies two thirds of the way through.
