# eval/ — measuring the things we otherwise assert

Retrieval and grounding quality are claims. This directory is where they become
numbers. Design: `docs/designs/athena-students.md` §11.

| Layer | Lives in | Asks | Runs |
|---|---|---|---|
| **1 — retrieval quality** | `eval/retrieval/` | did the right pages reach the prompt, and near the top? | before any retrieval-knob change |
| **1b — corpus coverage** | `eval/retrieval/` (needles) | can the index still be reached from EVERY corner of the corpus? | after re-indexing, an embedding change, or an ingestion-format change |
| **2 — generation grounding** | `eval/grounding/` | did the answer stay inside those pages? | on prompt/verifier/model changes |

> ### ⚠ The recorded retrieval baseline still needs re-running
>
> Reranking is **ON** in production as of 2026-08-25. The Cloud Run service
> account (`444715218641-compute@…`) holds the custom role `athenaReranker`,
> which carries exactly one permission — `discoveryengine.rankingConfigs.rank` —
> and `RERANK_ENABLED=1` is set on the service. Before that date the reranker was
> off, because the account had no Discovery Engine role at all and every ranking
> call would have 403'd into the dense fallback.
>
> `eval/retrieval/baseline.json` was captured on 2026-08-07 with `rerank: true`
> but at `scoreFloor: 0.12`. The shipped dense floor is now **0.58** (raised on
> eval evidence after that recording — see `STUDENT_QA_SCORE_FLOOR`). So the
> baseline matches production on the reranker and **not** on the floor: treat
> `mrr`, `contextPrecision` and `recallContext` as stale until layer 1 is re-run
> and the baseline recommitted.
>
> For reference, the reranker's measured contribution on the needle set
> (§ Layer 1b) is **hit@5 0.75 dense vs 0.81 reranked**, with hit@20 identical —
> ranking quality, not coverage. It also gates query decomposition, and it costs
> roughly $1 per 1,000 messages plus sending page text to a second Google
> service, so turning it off again is a real decision rather than a toggle.

---

## Layer 1 — the retrieval gate

```bash
npm run eval:retrieval                      # measure, compare to the committed baseline
npm run eval:retrieval -- --update-baseline # record a new baseline (commit it with the change)
npm run eval:retrieval -- --floor=0.58      # A/B the score floor
npm run eval:retrieval -- --no-boost        # A/B the concept→page boost
npm run eval:retrieval -- --case=kv-cache   # one case, verbose
npm run eval:retrieval -- --json=tmp/eval.json
```

It calls the real `student-qa-v1` profile through `searchMaterialPages`, so it
measures what a student's question actually runs through — namespace scoping,
visibility filtering at hydration, the concept→page boost, the locator lookup,
and the score floor. **No LLM judge**: the golden set labels which pages are
correct, so every number is deterministic and the same run twice gives the same
answer.

### What it needs

`.env.local` with `PINECONE_API_KEY`, `PINECONE_INDEX_MATERIALS`,
`GOOGLE_GENERATIVE_AI_API_KEY`, the Supabase URL + service-role key, plus:

```
EVAL_SECTION_ID=…       # the seeded eval course
EVAL_INSTITUTION_ID=…
```

It **refuses to run against a non-local Supabase** unless `EVAL_ALLOW_REMOTE=1`
— the eval corpus is a dev seed, and vector-db rule 12 keeps eval runs off live
tenant namespaces.

That is also why this is a CLI and not a Vitest suite: CI has none of those keys.
The pure rank math is unit-tested in CI at
`src/__tests__/retrieval-eval-metrics.test.ts`; the live run is a local (or
keyed-job) gate.

### The metrics

| Metric | Measured on | A drop means |
|---|---|---|
| `recallPool` (Recall@40) | the wide candidate pool | embedding/chunking miss — the right page never had a chance at any depth |
| `recallContext` | pages above the score floor | the page surfaced but lost its slot |
| `mrr` | same | ranking degrading while hit-rates stay green — the early warning |
| `contextPrecision` | same, rank-weighted | distractors outranking gold pages |
| `goldFoundRate` | answer cases | share that got at least one gold page into the prompt |
| `refusalAccuracy` | out-of-corpus cases | the honest-refusal branch (G1/G2) leaking answers |

`contextPrecision` is rank-weighted rather than raw precision@k because a
one-gold query would score 1/6 on a perfect result (the R-Precision caveat).

### How the gate decides

It fails on **regression**, not on absolute score:

1. any aggregate more than 0.02 below the committed baseline, **or**
2. a case that found gold in the baseline and misses now, **or**
3. a refusal case that has started answering.

Cases already failing at baseline are printed under **"known failures carried in
the baseline"** every run, so ratcheted debt stays visible instead of quietly
becoming the norm.

### The golden set

`eval/retrieval/golden.json` — 28 curated cases + 4 out-of-corpus refusals over
the seeded CS584 course, in the schema §11 specifies (`must_contain` arrives with
layer 2, which is the layer that produces answers to match against). Each case
carries a `use_case` tag pointing back at the catalogue row it came from
(§12.1 `U*`, §12.3 `G*`, §15.2 copilot prompts), including the copilot artifact
prompts — "make me flashcards for backprop through time", "quiz me on
self-attention", "write me a study guide for…" — which are retrieval-shaped
because an artifact may only cite pages retrieved on that turn (§15.4).

**Gold pages were chosen by reading the page text**, never by running retrieval
and blessing the output — a gate labelled from its own behaviour cannot fail.
They are keyed by material *title* + page and resolved to `module_item_id` at run
time, so a re-seed with fresh UUIDs doesn't rot the set; an unresolvable title or
an unindexed gold page is a hard error, never a silent recall miss.

### What layer 1 deliberately cannot cover

Most of the catalogue isn't retrieval-shaped, and forcing it in here would
produce cases that can't fail. Where the rest belongs:

| Catalogue rows | Why not here | Where they belong |
|---|---|---|
| U7, U8, U10–U12 · all of §12.2 (C1–C19) | answered by self-scoped **tools** (grades, mastery, calendar, attendance) — no page retrieval to score | tool unit tests + layer 2 |
| U3 ("summarize week 3") | legitimately answerable from many pages, so any gold set is arbitrary — it's a coverage question, not a ranking one | layer 2 (faithfulness/coverage) |
| U9, U15 | prompt behaviour (Socratic hinting, explaining *your* wrong answer) | layer 2 + prompt tests |
| U16, U20–U24 | transcript lane — this gate runs `includeTranscripts: false` so a demo room's spoken slides can't drift the baseline | its own transcript gold set |
| U17–U19 | drive-and-pre-fill actions; nothing is retrieved | e2e |
| G3–G14 | prompt **assembly** and route locks (unattempted-quiz exclusion, the G8 423, peer-data absence) — enforced before/around retrieval | `athena-chat-quiz-lock.test.ts`, `ai-tutor-prompt.test.ts` |
| §15.2 knowledge-map prompt | stops come from roadmap **graph** matching, not vectors | `knowledge-path` unit tests |

`G1` (out-of-corpus fabrication) and `G2` (empty corpus) *are* measurable here —
they are exactly the refusal cases, since the honest-refusal branch fires when
nothing clears the score floor.

### Known corpus gaps

The run warns when the eval course has no stored `content.concepts`: that data
feeds both the concept→page boost and the explicit-locator candidate list, so
without it those two paths are inert and the cases covering them measure
nothing.

This has bitten once and is worth knowing about. The seeded course had page
text but had never been through extraction, so two shipped features were dead
and the locator case read as a retrieval bug. Re-running extraction over all 19
materials ($10.74) moved every metric with **no code change**:

| | Before | After |
|---|---|---|
| recall@40 (pool) | 0.9405 | **0.9762** |
| recall into context | 0.7619 | **0.8155** |
| MRR | 0.6727 | **0.7676** |
| context precision | 0.636 | **0.7033** |
| gold-found rate | 0.9286 | **0.9643** |
| refusal accuracy | 1.00 | 1.00 |

`locator-lecture6-slide27` went from a total miss to rank 1. If the gate ever
looks broken on a fresh corpus, check this first.

## Layer 1b — the needle set (corpus coverage)

```bash
npm run eval:needles                          # measure, compare to the baseline
npm run eval:needles -- --update-baseline
npm run eval:needles -- --rerank              # A/B the cross-encoder
npm run eval:needles:generate                 # regenerate the questions (costs a few cents)
npm run eval:needles:generate -- --dry-run
```

The curated set measures ranking on 34 questions a human chose. That leaves a
blind spot it cannot see: a whole lecture could fall out of the index and every
curated case would stay green. The needle set samples the **corpus** instead —
100 pages on an even stride across every material — and asks one generated
question per page, with that page as its only gold answer.

**The rule that makes it a test, not a keyword lookup:** the generator first
lists the page's distinctive vocabulary, then must write a question using none
of it. "What is scaled dot-product attention" finds its page by lexical luck on
any model; *"why do we divide the scores by the square root of the dimension"*
has to be found semantically. `loadNeedleSet` re-checks the ban at load, so a
hand-edited question can't quietly reintroduce the easy version.

| | dense (baseline) | with `--rerank` |
|---|---|---|
| hit@5 | 0.75 | **0.81** |
| hit@10 | 0.85 | 0.86 |
| hit@20 | 0.91 | 0.91 |

Baseline is recorded **dense**, deliberately: the cross-encoder reorders what the
embedding already found, so it cannot repair a coverage miss — visible above as
an identical hit@20 and a materially better hit@5. Running dense keeps the signal
clean and the cost at one embedding per needle.

The gate fails on a needle that **used to be found at any depth and now isn't**,
or on a hit-rate more than 0.02 below baseline. Every miss is printed with the
question and what came back instead, because that list is the finding.

**These are machine labels.** The gold page is whichever page the question was
generated from, which is a strong claim about presence and a weak one about
ranking — a question about the encoder→decoder handoff is legitimately answered
by several pages. That is why they live in a coverage metric and never in the
curated set's precision means. Around 9 of the 100 miss at baseline, and reading
them shows a mix of real gaps and questions whose "gold" page was never unique.

Regenerating produces *different* questions (the model doesn't repeat itself),
which moves the baseline for reasons unrelated to retrieval. Regenerate when the
corpus changes, not casually — and re-record the baseline in the same commit.

## Layer 2 — grounding

```bash
# one-time
python3 -m venv eval/grounding/.venv
eval/grounding/.venv/bin/pip install -r eval/grounding/requirements.txt

npm run eval:grounding                     # answer the golden set, gate, then judge
npm run eval:grounding -- --no-judge       # deterministic half only
npm run eval:grounding -- --rescore        # re-derive metrics from the last run, no cost
npm run eval:grounding -- --case=kv-cache  # one case (writes records.case.jsonl)
npm run eval:grounding -- --update-baseline
npm run eval:grounding -- --strict         # promote fabrication warnings to failures
```

Two steps. `export.ts` runs the real path — `retrieveForQuestion` → the real
`buildAiTutorPrompt` → one Gemini call at the route's own budget — and writes
`records.jsonl`. `judge.py` scores those records with RAGAS.

### What gates, and what only reports

| Metric | Kind | Meaning |
|---|---|---|
| `citationValidity` | **gate** | share of citations naming a page the model was actually shown. Anything below 1.0 is an invented source |
| `refusalNoFabrication` | **gate** | out-of-corpus questions have an EMPTY context, so any citation there is invented by construction (G1) |
| `citedAnything` / `answered` | **gate** | share of answers that cited at all / said anything at all |
| `citationCorrectness` | **gate** | concentration of citations on the human-labelled gold pages — see the caveat below |
| `faithfulness` | report | share of the answer's claims entailed by its pages — the production verifier's question (§2 box 5), asked offline |
| `answer_relevancy` | report | does the answer address the question (catches grounded-but-evasive) |
| `refusal_compliance` | report | did an out-of-corpus answer decline rather than teach the topic anyway |

The split is the whole design. Citations are machine-checkable, so they fail the
run. Faithfulness and relevancy come from a model grading a model and move a
couple of points between identical inputs; gating on them would teach everyone to
re-run until green.

**`citationCorrectness` is not "share of citations that are right".** Gold labels
are the pages a human said answer the question; they are not an exhaustive list
of pages worth citing. An answer that also cites two other retrieved pages is
behaving correctly and scores ~0.5. Read it as concentration, and read
`citationValidity` for correctness.

**Fabrication is a warning, not a failure, by default.** Answers are generated at
the production temperature (0.7), so one case inventing a citation on one run and
not the next is sampling. The aggregate still gates; the offending citation is
printed in full; `--strict` promotes it.

### Known judge noise — read before believing a number

Faithfulness counts every extracted statement, including ones that are not
factual claims about the material. Observed on `late-submission-penalty`, whose
every bullet is verbatim on the cited page: it scored **0.20** with the judge's
reasoning off and **0.50** with it on, because the answer's closing "reach out to
your professor if you're worried" is a statement no page entails. Neither number
means the answer was ungrounded. This is exactly why judged metrics report.

### Switching the judge

Nothing in `judge.py` is Gemini-specific — every provider goes through one
OpenAI-compatible client, so changing judges is a key and an env var:

```bash
EVAL_JUDGE_PROVIDER=google      # default; reuses GOOGLE_GENERATIVE_AI_API_KEY
EVAL_JUDGE_PROVIDER=openai      # OPENAI_API_KEY        (pip install langchain-openai)
EVAL_JUDGE_PROVIDER=anthropic   # ANTHROPIC_API_KEY
EVAL_JUDGE_PROVIDER=custom EVAL_JUDGE_BASE_URL=https://…   # any compatible gateway
EVAL_JUDGE_MODEL=…  EVAL_JUDGE_API_KEY=…  EVAL_JUDGE_EMBEDDINGS=none
```

A different judge produces different numbers, so record a fresh baseline when you
switch — `baseline.json` stores which judge wrote it. Two settings are load-bearing
and were found the hard way: the judge needs a large `max_tokens` (structured
output after reasoning), and on Google it runs at `reasoning_effort=low`, because
at the default half the run failed with truncated structured output.

### What layer 2 deliberately does not run

**No tools, no drive channel.** The golden set is retrieval-shaped, the eval has
no enrolled student to scope a self-scoped tool to, and a tool result would put
text in the answer that came from neither the model nor the retrieved pages —
which is what faithfulness is measuring. A turn that ends in a tool call is
carried in the records, kept out of every aggregate, and named in the report, so
"the model wanted a tool this harness doesn't pass" never reads as an empty answer.

`records.jsonl` and the venv are gitignored. The committed artefacts are
`baseline.json` (the numbers) and `requirements.txt` (the judge).
