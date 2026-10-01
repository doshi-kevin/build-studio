# Athena — Cost per Query

**Purpose:** Before asking "can Athena do this?", weigh what the task is worth against what an Athena query costs. This doc is the team's single source for that number, across every Athena surface — the five professor-side ones and the student tutor — **plus the costs that fire around a query rather than inside it** (chat auto-titling, Google Search grounding, retrieval), which are 24% of the bill and were missing from this doc until 2026-08-18.

*Last updated: 2026-08-18 · Data window: 2026-06-23 → 2026-08-16 · 1,217 turns, $7.50 in model tokens — plus $2.39 in per-conversation and grounding side costs the table below never showed → **$9.89 all-in**. All figures are TRUE billed costs: the raw ledger overstates thinking-enabled rows (see the double-count caveat below) and every number here is corrected for it.*

## The numbers

One ledger row = one user message (the recorded usage covers Athena's entire multi-step tool loop for that turn, so these are true per-query costs).

| Surface | Model | Queries | Avg / query | Median | P90 | Max |
|---|---|---:|---:|---:|---:|---:|
| Athena console (`professor_assistant`) | Pro (default) | 85 | **$0.032** | $0.020 | $0.036 | $0.81 |
| Athena console (`professor_assistant`) | Flash | 253 | **$0.004** | $0.003 | $0.007 | $0.012 |
| Assignment studio (`assignment_assistant`) | Flash | 517 | **$0.002** | $0.002 | $0.003 | $0.048 |
| Assignment studio (`assignment_assistant`) | Pro | 2 | **$0.010** | $0.010 | — | $0.012 |
| Quiz studio (`quiz_assistant`) | Flash | 170 | **$0.004** | $0.003 | $0.006 | $0.030 |
| Frontier design arc (`athena_frontier`) | Flash | 13 | **$0.004** | $0.004 | $0.006 | $0.008 |
| Student tutor (`ai_tutor`) | Flash | 177 | **$0.011** | $0.005 | $0.016 | $0.087 |
| About page (`about_assistant`) | Flash | 0 | shipped 2026-08-17, **no traffic yet** | | | |
| Projects authoring (`project_assistant`) | Flash | 0 | shipped 2026-09-16, **no traffic yet** | | | |
| **All Athena turns, blended** | | **1,217** | **$0.006** | | | |

**Planning number: ~3¢ per Athena console query.** Pro (`gemini-3.1-pro-preview`) is the deliberate quality-over-cost default professors land on, so plan with the Pro average, not the blended one. Two things the earlier version of this table got wrong by omission:

- **The student tutor is the expensive Flash surface — $0.011/turn, ~5× the assignment studio.** Every tutor turn carries the RAG'd course-materials block: avg 27k input tokens (15k of it cached) against the studio's ~4k. It is Flash, but it is not noise, and it multiplies by *enrolled students* rather than by professors.
- **Quiz studio and Frontier are ordinary.** Both land at ~$0.004 — Frontier's design arc costs more per *arc* (several turns + grounded searches), not per turn. 13 turns is too few to call turns-per-arc; that number is still open.

### The side costs the per-query table doesn't contain

One ledger row = one user message. These fire *around* those turns and were never in the table — together they are **24% of Athena's total spend**.

| Side cost | Ledger | Events | Avg | Median | Max | Total |
|---|---|---:|---:|---:|---:|---:|
| Chat auto-titling (`conversation_title`) | `ai_usage_events` | 176 | **$0.011** | $0.001 | $0.378 | **$1.98** |
| Google Search grounding (`google:search_grounding`) | `external_usage_events` | 29 queries | $0.014 flat | — | — | **$0.41** |
| Tutor/console retrieval (`material_search` embed + Pinecone read units) | both | 128 | ~$0.00002 | — | — | $0.003 |

**Naming a chat costs 4× the studio turn it names.** `maybeAutoTitle` (professor console, `professor-assistant/persistence.ts`) and `generateConversationTitle` (student tutor, `ai-tutor/actions.ts`) both call `generateText` on Flash with **no `thinkingConfig`**, so the model reasons at the provider default before emitting a 3–6 word title: 150 of 176 rows carry reasoning tokens (avg 2,578, max 62,915). True billed cost: **$1.98 across 176 titles — 20% of the all-in Athena bill, within sight of the console's entire Pro spend ($2.72)** — avg $0.011 per title against $0.002 for the authoring turn underneath it. The tail is real and pre-dates any measurement quirk: two titles from 2026-07-17/19 each burned ~125k thinking tokens (**$0.378 per title**), and a third on 2026-08-16 thought for 62,911 tokens ($0.19). It is not historical: the week of 2026-08-10 alone was 111 titles for $1.11. Both call sites are one `providerOptions.google.thinkingConfig` away from the same shape as every other Flash call in the codebase — filed as an open item below, not fixed here.

**Grounding is now priced (the 2026-07-20 caveat is stale).** `recordExternalUsage` has been wired on both Athena routes since 2026-07-30, at Google's $14/1,000-queries rate. The two ledgers reconcile exactly — `events.metadata.groundingQueries` counts 29 queries since 2026-07-30 and `external_usage_events` prices exactly 29. What that buys us in honesty:

- **One grounded search costs $0.014 — roughly 6× the entire Flash turn that fired it.** On the assignment surface 39 of 198 turns (20%) searched, averaging 2.3 queries each, so a searching turn is ~$0.035 all-in against $0.002 for a quiet one. Grounding, not tokens, is what makes an Athena turn expensive on Flash.
- **103 grounded queries from before 2026-07-30 are counted but unpriced** (~$1.44 at today's rate). They are not in any total above; the $9.89 headline is token spend + priced grounding only.

### The hard ceiling (rate limits, recomputed 2026-08-18)

Athena's daily caps are **per surface**, not global: `ATHENA_LIMIT_SCOPES` in
`src/lib/ai/professor-assistant/models.ts` now lists **seven** — `console`, `assignment`, `quiz`,
`grade`, `about`, `project` and `tutor` — each with its own 150 Flash + 30 Pro per rolling 24h (`dailyCap`).
Draining one no longer locks the others, which is the point, but it also means the ceiling is seven
pools wide. At the measured averages above:

- one professor pool fully drained ≈ **$1.55** (150 × $0.004 Flash + 30 × $0.032 Pro)
- **all six professor-reachable pools drained ≈ $9.29 per professor per day** (`tutor` is not one of them)
- **the `tutor` pool is per STUDENT and Flash-only** (no Pro failover, by design) — 150 × $0.011 ≈ **$1.60 per student per day**. That is the ceiling that scales with enrolment: a 30-student section is $48/day worst case, six times the professor's own ceiling.

That is a ceiling, not a forecast — 180 turns on a single surface in one day is far beyond observed
use, and the blended average above is what real traffic costs. Quote the ceiling only for
worst-case/abuse budgeting. **Adding a seventh scope adds another $1.55 to it**, which is why the
scope list is pinned by a CHECK constraint and a new one needs a migration. Note that the caps
bound *turns*, and the side costs above are not turns: auto-titling and grounding sit outside every
number in this section.

### How to use this when scoping a feature

"Can Athena do this?" is the wrong first question. Ask, in order:

1. **Is the task deterministic?** If a button or a plain query can do it exactly, build that — it costs $0 per use and never hallucinates. Athena earns its cost only where judgment, language, or synthesis is needed.
2. **What's the monthly bill?** `avg cost/query × expected queries/month × professors`. A 3¢ query a professor runs twice a day is ~$2/mo per professor; one embedded in a loop over every student is a different animal. Volume, not unit cost, is what bites.
3. **What's the prompt tax?** Every tool added to Athena inflates the system prompt of **every** query, used or not. One more tool is cheap (~hundreds of input tokens, fractions of a cent at Pro rates, further softened by caching) — but this compounds, and it's the reason "just add it as a tool" shouldn't be the default answer.

   **Worked example, and the failure mode on the other side (2026-09-15).** `show_outcome_coverage` (ABET coverage, read-only) was originally withheld from the About, quiz, grading and no-host surfaces on exactly this argument, leaving it on the console and the assignment builder. The cost of that: a professor asked "ABET outcomes?" on the About page, the model had no tool that could answer, reached for the only actionable tool it *did* have (`apply_edits`), tried to edit the page, was refused because the page was in preview, and the turn ended with two error notices and no answer. Priced against the table above, the tool's description is a few hundred input tokens on a Flash turn, on a surface that logged **14 turns in 90 days** ($0.08 total). The tax was real and correctly identified; it was just three orders of magnitude smaller than the thing it was protecting. **The lesson is not "ignore the prompt tax" — it is to price it against measured traffic on that specific surface, and to weigh a missing capability as a cost too.** A professor does not know which screen holds which knowledge.
4. **Is the value ≥ the bill?** If the feature saves a professor real minutes or produces something they'd otherwise not get, 3¢/query is trivially worth it. If it's a convenience wrapper around an existing page, it isn't.

## How it's calculated

Costs come from the `ai_usage_events` ledger in prod (every LLM call site writes to it via `recordAiUsage` in `src/lib/ai/usage.ts`; pricing per model lives in `src/lib/ai/cost.ts`). Reproduce with:

Until the double-count fix lands (see caveats), quote TRUE cost, not stored cost — the
`true_cost` expression below subtracts the double-counted thinking share:

```sql
with t as (
  select *, cost_usd - coalesce((metadata->>'reasoning_tokens')::numeric, 0)
    * case model when 'gemini-3.1-pro-preview' then 12.0 else 3.0 end / 1000000 as true_cost
  from ai_usage_events
)
select feature, model, count(*) as queries,
  round(avg(true_cost)::numeric, 6)  as avg_cost_usd,
  round(percentile_cont(0.5) within group (order by true_cost)::numeric, 6) as median,
  round(percentile_cont(0.9) within group (order by true_cost)::numeric, 6) as p90,
  round(max(true_cost)::numeric, 6)  as max,
  round(sum(true_cost)::numeric, 4)  as total
from t
where feature in ('professor_assistant', 'assignment_assistant', 'quiz_assistant',
                 'athena_frontier', 'about_assistant', 'project_assistant',
                 'ai_tutor', 'conversation_title')  -- add new Athena feature labels here
group by feature, model order by feature, queries desc;
```

The side costs live in a second ledger (`external_usage_events`, written by `recordExternalUsage`
in `src/lib/costs/external-usage.ts`; rates in `src/lib/costs/external-rates.ts`). Quoting an
all-in Athena number means summing both — the token query above **and**:

```sql
select provider, feature, unit, count(*) as events, sum(quantity) as qty,
  round(sum(cost_usd)::numeric, 4) as total
from external_usage_events
where (provider, feature) in (('google', 'search_grounding'), ('pinecone', 'material_query'))
group by provider, feature, unit;
```

### Caveats — read before quoting these numbers

- **All traffic to date is Scholera Dev (internal testing).** No real institution has generated Athena queries yet. Token-per-query shape is representative of the workload; the Flash/Pro *mix* reflects our testing habits, not professor behavior — another reason to plan at the Pro rate.
- **Google Search grounding IS in these numbers now** (it wasn't on 2026-07-20). Google bills grounded queries per-1,000-queries rather than by tokens, so they sit in `external_usage_events`, not the token ledger — priced since 2026-07-30 at $14/1k, wired on both Athena routes, and reconciling exactly against the `groundingQueries` count in `events`. Two live gaps remain: the 103 grounded queries from **before** 2026-07-30 are counted but unpriced (~$1.44), and the student tutor route never counts grounding at all (it doesn't ground today — if it ever does, `countGroundingQueries` + `recordExternalUsage` have to be added there too).
- **The raw ledger double-counts thinking tokens (found 2026-08-18, live-call-verified; code fix pending).** Under `ai` v6 the SDK's `usage.outputTokens` for Gemini **already includes** reasoning tokens (`outputTokenDetails.reasoningTokens` is the split) — proven with a single live Flash call whose response carried both the SDK usage and Google's raw `usageMetadata`: prompt 35 / candidates 5 / thoughts 249, SDK `outputTokens` 254. `recordAiUsage` then adds `reasoningTokens` on top, so every thinking-enabled row since reasoning persistence began (2026-07-22, 600 rows) stores output and cost inflated by exactly `reasoning_tokens × output rate` — **$3.56 platform-wide, of which $1.16 on titling and $0.28 on Athena surfaces**. The signature is unambiguous: all 150 thinking title rows have `output_tokens − 2×reasoning ≈ 5` (a title is ~5 text tokens). Rows before 2026-07-22 are correct (they never passed `reasoningTokens`). The error is conservative — the real bill comes in LOWER than the ledger — and every number in this doc is corrected: `true cost = cost_usd − reasoning_tokens × output_rate / 1e6`. The super-admin Cost Analysis dashboard still shows the inflated stored values until the code fix + row repair land.
- **The search policy is a prompt-tax line item.** Its `<web_search>` block sits in the assignment/quiz route's cacheable `CONTRACT` prefix, so it inflates the input side of *every* query on that route whether search fires or not — a few hundred input tokens, fractions of a cent at Flash rates and softened by caching. Noted because framework step 3 exists precisely to keep these visible as they accumulate.
- **The $0.81 max is real.** One Pro query with huge context/output cost 25× the average. Tail risk exists; the P90 is the honest "expensive query" number.
- Stored `cost_usd` is internally exact: a full-ledger audit (2026-08-18, all 3,146 rows, every model) recomputes every row from its stored token columns to within $0.000001, and the rate table in `cost.ts` was re-verified against Google's live pricing page the same day (all rates current; thinking billed at output rate confirmed; no Pro prompt has ever exceeded the 200k tier boundary). Internal consistency is what that proves — the thinking double-count above is about the stored *tokens* being wrong, not the arithmetic on them. The `external_usage_events` ledger recomputes exactly too (quantity × rate, 0 mismatches).

## Keeping this doc alive

**Update this doc whenever Athena changes shape** — a new tool, a new surface (e.g. student-side Athena), a model/default change, or a pricing change in `cost.ts`. Concretely:

1. New surface → add its `feature` label to the SQL above and a row to the table.
2. New tool on an existing surface → after it's been live ~2 weeks, re-run the SQL and refresh the table (a heavy tool shifts the average; that shift is the signal).
3. Model or pricing change → re-run and update the planning number.
4. **Check the side costs too** — a new per-conversation or per-provider call (titling, grounding,
   retrieval, TTS) never shows up as a surface row, so a table that only reads `ai_usage_events`
   by surface will look complete while missing a third of the bill. That is exactly how the
   `conversation_title` line went unnoticed for a month.
5. Bump the *Last updated* line and data window.

### Pending re-run — Studio attachments went from one kind to all of them (2026-09-21)

The builder's paperclip used to upload a student-facing file the model never saw, on every kind
except `about`. It is now a chat attachment Athena reads, on every kind and on the grading surface.
No new `feature` label: these turns already bill as `assignment_assistant`, `quiz_assistant`,
`project_assistant` and `about_assistant`, so the existing SQL picks the change up on its own.

What to expect when you next re-run it, so the shift is read as this change rather than as noise.
Input tokens per turn rise on any thread carrying a file, and they rise on EVERY later turn of that
thread, because an attachment is re-inlined each time. Gemini bills a PDF at roughly 258 tokens per
page, so a 30-page PDF is about 7.7k input tokens per turn. Two bounds cap the worst case:
`modelDef.attachments.maxFiles` (5) stands older attachments down to a one-line note, and
`MAX_INLINED_TEXT_CHARS` (100k) bounds a text file that would otherwise be pasted in whole.

Worth checking at the same time: the professor console calls `materializeFileParts` with no
`maxFiles` argument, so its attachments re-inline uncapped across a 40-message window. That is
pre-existing and was not changed here.

### Open item — chat auto-titling burns thinking tokens (found 2026-08-18, **not fixed**)

The one-shot call that names a conversation is, per event, the most wasteful call we make:
`conversation_title` — **176 events, $1.98 true cost, avg $0.011 each** — 4× the studio turn it
sits on top of, and 20% of the all-in Athena bill.

The cause is a one-line asymmetry. Every Athena *stream* pins thinking explicitly —
`providerOptions: { google: { thinkingConfig: { thinkingLevel: modelDef.thinkingLevel } } }`, and
the Flash def is `thinkingLevel: 'minimal'`. The two title calls —
`maybeAutoTitle` in `src/lib/ai/professor-assistant/persistence.ts` and
`generateConversationTitle` in `src/app/(dashboard)/student/courses/[sectionId]/ai-tutor/actions.ts`
— call `generateText` with only `model` and `temperature`, so they inherit the provider default and
reason at length before emitting six words: 150 of 176 rows carry reasoning tokens (avg 2,578, max
**62,915**). Two titles have each burned ~125k thinking tokens — **$0.378 for six words**, twice.

Three things worth stating plainly:

1. **It is current, not historical.** Week of 2026-08-10: 111 titles, $1.11.
2. **It scales with conversations, not turns** — and the student tutor opens one per question
   thread, so it multiplies by enrolled students on the surface that already costs the most.
3. **Chasing this number is also what surfaced the thinking double-count** (see the caveat above):
   the stored titling total read $3.14, and proving whether that was real led to the live-call
   check that showed every thinking row since 2026-07-22 is inflated. $1.98 is the true figure.

The fix is the same `thinkingConfig` block the streams already use, on both call sites — not done
here, because this doc measures and does not change behaviour.

### Open item — topic-mastery context (added 2026-08-14, **measured 2026-08-18**)

Athena can now see the course's curated topic mastery (`skills` + `skill_mastery`) — the class
score per topic for professors, the student's own mastery for students. **Deliberately added no
new tool**, precisely to avoid framework step 3: the data rides on loaders that already existed,
so the *always-on* prompt on every surface is unchanged.

Where the cost actually moved:

1. **`get_class_struggles` payload grew** (assignment authoring + quiz studio). It now carries up
   to 40 scored topics. **Measured, not estimated:** on the 195-topic NLP section the added
   `topicMastery` block is ~4 KB, i.e. roughly **+1,000 input tokens on the turns it is called**,
   and zero on the turns it isn't. The alternative, a second `get_topic_mastery` tool, would have
   cost ~150 input tokens on EVERY turn of those surfaces whether used or not — so the payload is
   the cheaper side of that trade only while the tool fires on well under ~15% of turns. **Re-check
   this once real professors use it**; if it fires on most authoring turns, the trade inverts and
   the cap (`TOPIC_DIGEST_MAX`) should come down.
   *Sizing note:* the cap is 40 rather than a handful because a short list makes the digest blind
   to the middle of the range — the model then reports a mid-scoring topic as untracked.
2. **The student always-on lane is unchanged in size** — it already read the mastery scores and
   discarded them; it now prints them. No extra query, no extra turn.
3. **`get_my_study_focus` gained the student's course-wide standing** at zero extra I/O — the read
   behind it already computed the number and threw it away.
4. **Not free on the DB side:** `skillQueries.getSectionMasteryRows` is now paged rather than a
   bare select. That is a correctness fix (PostgREST silently caps at 1000 rows, which was making
   the class median *wrong* on any course past ~90 students, on the roadmap page too) — but it
   means >1 round trip on large sections.

**Measured (2026-08-18): topic mastery did not move the steady-state average — the agent loop did.**
Comparing `assignment_assistant` input tokens before/after 2026-08-14 looks alarming at first
(4,197 → 29,363 avg) but the whole shift is one day: 2026-08-14 ran median 30,562 input tokens
at $0.0065/turn, which is the 55-call tool-loop QA session described below, not authoring. Two
days later, after the memoisation fix, the surface is back to **median 4,282 input tokens and
$0.0024/turn** — its pre-change baseline. Quiz studio never moved at all ($0.0028 avg on
2026-08-14 against a $0.0038 lifetime average). So the payload-over-tool trade still holds at
`TOPIC_DIGEST_MAX = 40`; **re-check it again against real professor traffic**, since every number
here is still internal QA.

**Open risk found in QA — the agent loop, not the data.** On one quiz-studio prompt the model
called `get_class_struggles` **55 times** and returned no answer: `MAX_AGENT_STEPS` bounds a single
request, but a stream ending on `finishReason: 'tool-calls'` is auto-resubmitted by the panel, so
the loop spanned 11 requests × 6 executions. The final request body was 233 KB carrying 56 copies
of the tool result. This predates the topic-mastery change, but the change **raised its unit cost**
— each execution now also runs a whole-section `skill_mastery` read. Mitigated here by memoising
the tool's promise per request (66 reads → 11) and by telling the model in the tool description to
call it at most once per turn. **Neither bounds the resubmit chain itself**, which is the actual
defect and remains open: a client-side cap on consecutive tool-call resubmissions is the real fix.

### Open item — `project_assistant` (added 2026-09-16, no traffic yet)

The Projects authoring surface. Two tools only (`apply_edits` + `get_project_context`), the
same minimal budget the About surface holds, so per-turn cost should land with the other Flash
authoring rows. It has its OWN pool (`project` scope, migration `20260915194440`), which grew
the per-professor abuse ceiling by one more pool.

The number worth measuring here is not cost per turn, it is **turns per applied proposal**.
The surface exists so that ONE turn produces a whole phase timeline and rubric; if professors
need five turns to land a structure, the fix is the prompt guidance, not the model. The ratio
is computable: `project_assistant` ledger rows against `project.athena_proposal_applied`
events, both of which carry the project id.

### Open item — `about_assistant` (added 2026-08-17, **zero traffic as of 2026-08-18**)

Athena on the course About page builder — the `about` authoring kind on the
assignment-assistant route. The label is wired (`assignment-assistant/route.ts` maps
`activeKind === 'about'` to `about_assistant`) but the ledger has **0 rows**: it merged
2026-08-17 and hasn't been exercised. Nothing to measure yet — the row stays at zero until
it is. It has its OWN rate-limit pool (`about` scope, migration
`20260817214138`; the per-professor daily abuse ceiling grew by one pool, ≈$1.65,
to ~$8.25 across six pools). Framework notes:

1. **Two tools only** (apply_edits + get_course_data) — the six behaviors
   (auto-fill, schedule derivation, drift check, page review, policy stress-test,
   syllabus import) are prompt-driven over them, deliberately, per step 3.
2. **Import turns are the expensive shape**: the attached syllabus (PDF inlined,
   or txt as text) rides EVERY subsequent turn of that thread — same recurring
   cost as console attachments. Expected use is one import per course, front-
   loaded at semester start; volume is inherently small.
3. **Usage shape to check after ~2 weeks live**: turns per page-build session, and
   whether get_course_data fires often enough that folding its payload into the
   always-on prompt would be cheaper (it won't be unless it fires on most turns).

### Open item — `athena_frontier` (added 2026-07-28, **unit cost measured, per-arc still open**)

Frontier Mode is a MODE of the assignment surface, not a new endpoint, but it gets its own
`feature` label because its cost shape is different in kind: a design arc is several
conversational turns (an elicitation exchange, then pairings) plus one or more grounded
searches per candidate shell, then a build turn that emits an assignment, a rubric and a
design record. Folding that into `assignment_assistant` would hide both numbers — it would
inflate the ordinary-authoring average and understate the arc.

**Measured (2026-08-18): 13 turns, $0.004/turn — indistinguishable from ordinary Flash
authoring.** Which is the expected result: the arc's cost was never in the unit price. Both
things that make it different are still unmeasured, because 13 turns across two sessions is
not a sample:
1. **Turns per completed design.** The planning cost is (turns x per-query cost), so this is
   the load-bearing variable, not unit cost. Query `athena_frontier` rows grouped by day.
2. **Grounded queries per arc.** Frontier explicitly permits one search PER CANDIDATE SHELL
   (two or three), against the general "one search is normally enough" bound — so it is the
   first surface expected to search more than once per turn. `event_logs` metadata
   `groundingQueries` already records it; these are counted but still unpriced (see the
   caveat above), so a high number here is the strongest argument for finally pricing them.

### Open item — student attachments on `ai_tutor` (added 2026-07-31, **surface measured, attachment split still open**)

Students can now attach files to an Athena question (`/api/chat/upload` → the same
`athena-attachments` bucket and Gemini inlining the professor console uses). The student tutor
already meters as `ai_tutor` via `recordAiUsage`; **that label is now in the SQL and the table
above** — 177 turns at $0.012 each, the most expensive Flash surface we run.

The *split* is still open, and can't be done from the ledger as written: `recordAiUsage` in
`src/app/api/chat/route.ts` passes no `metadata`, so nothing marks a turn as carrying an
attachment. Splitting it means either stamping `metadata.hasAttachment` at that call site or
joining back to `ai_messages`. A naive before/after on the 2026-07-31 ship date says the
opposite of what you'd expect (pre $0.022 → post $0.011) — that's 15 rows of pre-period noise,
not an attachment effect, and is exactly why the flag is worth adding.

Why it deserves its own look rather than a footnote:

1. **An attachment is a RECURRING input cost, not a one-off.** The bytes are re-inlined on every
   subsequent turn of the thread (bounded only by the thread length), so a 10MB PDF attached once
   is paid for again on each follow-up. This is the single reason the student ceiling is set
   tighter than the professor's (3 × 10MB vs 5 × 20MB) — see `STUDENT_ATTACHMENTS`.
2. **It shifts the grounding mix.** A turn with an attachment takes the no-retrieval branch, so it
   trades the course-materials block for the file — cheaper on one side, dearer on the other. The
   net is an empirical question.
3. **Volume shape is student-side, not professor-side.** Every framework step-2 estimate in this
   doc is per-professor; the tutor multiplies by enrolled students instead.

Also still missing: no per-student upload quota and no TTL sweep for attachments on abandoned
threads (the professor side has the same gap, tracked in the bucket migration).

A path-scoped rule (`.claude/rules/athena-cost.md`) reminds Claude of this whenever Athena code is edited.
