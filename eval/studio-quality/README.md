# Studio generation quality eval

Measures how good the plugins the Studio builder makes are as products, against the rubric `studio-generation-quality-v1`. It exists to freeze an honest baseline of the Step 11 builder before Step 12 changes it. The design and the decisions behind it are in `docs/designs/studio/studio-generation-quality.md` (local only).

Status: the framework is built (Step 12A.2). The evaluator is calibrated against contrast pairs and repeatability, and awaits blind human scoring (Step 12A.3). There is no baseline yet (12A.4).

## What a run does

For each canonical case (`cases.ts`): Tier 1, Core Educational Workflows (Q01 to Q20, the tools professors ask for most) and Tier 2, Complex Product Reasoning (D01 to D08, deeper products on the same platform). Both tiers use the same rubric.

1. **Build** (live only). The frozen Step 11 builder builds the professor's request with the real harness and check worker, against an in-memory run store. A scripted professor approves every card and answers any question with "Use your judgement for a typical university course".
2. **Gates.** The draft gate runs again on the committed snapshot, then Stage 2 runs through the real local runner. A build that didn't end Preview ready, broke a harness invariant, or failed the draft gate or Stage 2 boot or isolation gets no quality score and counts 0 in the suite mean.
3. **Screenshots** (`capture.mjs`). Both views at desktop and phone width on sample data, plus empty, loading and failing states, through the Stage 2 runner's servers. The builder's own renderer is not used.
3a. **Rendered evidence** (`render.ts`). After each screenshot the capture reads what the page actually shows from the live DOM (headings, text, buttons, controls and labels, tabs, table headers, badges, alerts, states), opening each tab on the normal desktop screen. The views' source is parsed for what it asks the kit to show, and anything that never rendered, or a screen that contradicts itself, becomes a check. `render-diagnose` shows this for saved artifacts without a model.
4. **Judge** (`judge.ts`). Pass A lists observable evidence, each item citing a screenshot, a view line, the manifest, the sample or a Stage 2 check. Pass B gives each of the nine dimensions one of four levels, citing Pass A items. Several runs judge each artifact; each dimension takes the median level.
5. **Integrity.** The result records that the source, the snapshot, the Stage 2 report and the screenshots are all of the same artifact. If any isn't, the result fails integrity and has no score.
6. **Result** (`schema.ts`). One `studio-generation-quality-result-v2` JSON per generation, validated before it is written, with the judged source kept beside it.

Only a live build that passed every gate, judged by a live judge on screenshots and code, is **comparable**. Imported folders, code-only evaluations and the plumbing judge are recorded but kept out of the primary statistics.

## Commands

```bash
# Check the pipeline on saved artifacts, spending nothing. The plumbing judge cites real
# evidence but its scores mean nothing.
npm run eval:studio-quality -- judge-only --from=tmp/product-bench4 --out=tmp/studio-quality/trial --judge=plumbing

# Summarise every result under a folder (writes report.json there).
npm run eval:studio-quality -- report --results=tmp/studio-quality/trial

# Live builds. Prints the plan and the cap and stops unless --yes is given.
npm run eval:studio-quality -- build --case=Q01-attendance --max-usd=5 --judge=google:gemini-3.1-pro-preview --judge-reasoning=high --yes

# Calibration (Step 12A.3)
npm run eval:studio-quality -- contrast-prepare                       # original and degraded pairs into tmp/
npm run eval:studio-quality -- contrast-report --results=<judged contrast folder>
npm run eval:studio-quality -- repeatability --results=<judged folder>
npm run eval:studio-quality -- human-pack --items=<result folder>,... --out=<pack> --key=<sealed key outside the pack>
npm run eval:studio-quality -- human-compare --scores=<pack>/human-scores.json --key=<sealed key>
npm run eval:studio-quality -- render-diagnose --from=<artifact folders> --out=<folder>   # what rendered vs what the source claims; no model
```

The live judge is Gemini (`--judge=google:gemini-3.1-pro-preview`), the only family with a non-production key here. It is the builder's model thinking harder than the builder does: `--judge-reasoning=high` (calibrated in 12A.3) or `medium`. Thinking `low` is the builder's own setting and is refused, and so is any other model, because a smaller one isn't stronger and only this one is calibrated. A live judge also refuses to start if the rubric or judge prompt differs from the frozen pair in `quality-freeze.ts`. Integrity is checked before judging, and an artifact that fails it isn't sent to the judge. Each judge call reserves its worst case (a full prompt and a full reply at the model's rates) against `--max-usd` before it is sent, and a cap too small for the calls that can run at once is refused up front.

A live build needs `--max-usd` (a hard cap over building and judging), `--yes`, and only `GOOGLE_GENERATIVE_AI_API_KEY` in the environment. It refuses any Supabase secret, and it refuses to start if the builder's instructions, review instructions, model or thinking level differ from Step 11's (`freeze.ts`). Never run it with the root `.env` loaded.

Cases: `--case=ID[,ID]` or `--set=dev|holdout|variance|all`, narrowed with `--tier=core|deep`. Holdout cases are refused everywhere unless `--allow-holdout` is given, which only the 12A.4 baseline does. Repeats for the variance cases reuse the baseline group: `--group=<id> --start-generation=2 --repeat=4`. Judging: `--judge-passes` (default 3) and `--allow-code-only` for a diagnostic evaluation when screenshots fail.

## Files

| File | What it holds |
|---|---|
| `rubric.ts` | The nine dimensions, their levels, evidence and what not to reward; scoring and the median |
| `cases.ts` | The 28 canonical requests in two tiers, goals, hints, Tier 2 review guidance, the six variance cases and nine holdouts |
| `sealed.ts` | Loads the sealed Tier 2 holdouts' goals and hints from a local file, for the baseline only |
| `build.ts` | One live build; takes only the request text |
| `freeze.ts` | The Step 11 builder's accepted hashes, model and thinking level |
| `platform-card.ts` | What a plugin can do, derived from the platform's constants, for the judge |
| `capture.mjs`, `evidence.ts` | Screenshots and Stage 2 |
| `judge.ts` | The judge interface, the two-pass protocol and the v4 evidence contract, the spend ledger, the scripted and plumbing judges |
| `render.ts` | Rendered evidence: the ledger, the source claims and the checks between them |
| `gemini-judge.ts` | The live judge on Gemini |
| `calibration.ts` | Contrast pairs, repeatability, the blind human pack and the human comparison |
| `quality-freeze.ts` | The frozen rubric and judge-prompt fingerprints |
| `gates.ts`, `evaluate.ts` | Gates, comparability, and one artifact to one result |
| `artifacts.ts` | Saved artifact folders, and the importer for Step 11 benchmark folders |
| `aggregate.ts` | Suite statistics, the per-tier report and outcomes, nondeterminism measures, baseline comparison |
| `run.ts` | The command line |

Tests: `src/__tests__/studio-quality-*.test.ts`. The contamination guards there fail if the builder changes, if production code imports this folder, or if a hint or goal reaches the model during a build.

## Holdout

Tier 1's Q07, Q10, Q13, Q15, Q17 and Q20 and Tier 2's D02, D05 and D06 are a process holdout. While tuning Step 12, don't read their detailed results to decide changes, and don't tune against one of their failures. Report them only in aggregate.

The Tier 2 holdouts are sealed as well: `cases.ts` has only their prompt and category. Their goals, hints and guidance are in `docs/designs/studio/sealed/studio-quality-tier2-holdouts.json`, which git ignores. A run with `--allow-holdout` loads it (or `--sealed-spec=<path>`), and stops if it is missing. Don't open it while tuning. A baseline run also writes each holdout's goals and hints into that artifact's `artifact.json` under `--out`, so don't open holdout artifact folders while tuning either.

## Reading a report

`report` writes `report.json` with a `tiers` section: Tier 1 and Tier 2 side by side, each with its development and holdout means, hard-gate pass rate, quality and dimension statistics, failure classes and outcomes. Each canonical case counts once, as its first generation. Outcomes separate a builder that ran out of budget, a broken invariant or isolation, a failed build or gate, an evaluation that couldn't score, a low score (below 55) and a scored build. The overall line is the plain mean of all 28 cases. It is descriptive only: a change is an improvement only if neither tier regressed.
