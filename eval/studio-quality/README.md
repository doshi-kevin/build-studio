# Studio generation quality eval

Measures how good the plugins the Studio builder makes are as products, against the rubric `studio-generation-quality-v1`. It exists to freeze an honest baseline of the Step 11 builder before Step 12 changes it. The design and the decisions behind it are in `docs/designs/studio/studio-generation-quality.md` (local only).

Status: the framework is built (Step 12A.2). There is no live judge yet (12A.3) and no baseline yet (12A.4).

## What a run does

For each canonical case (`cases.ts`, Q01 to Q20):

1. **Build** (live only). The frozen Step 11 builder builds the professor's request with the real harness and check worker, against an in-memory run store. A scripted professor approves every card and answers any question with "Use your judgement for a typical university course".
2. **Gates.** The draft gate runs again on the committed snapshot, then Stage 2 runs through the real local runner. A build that didn't end Preview ready, broke a harness invariant, or failed the draft gate or Stage 2 boot or isolation gets no quality score and counts 0 in the suite mean.
3. **Screenshots** (`capture.mjs`). Both views at desktop and phone width on sample data, plus empty, loading and failing states, through the Stage 2 runner's servers. The builder's own renderer is not used.
4. **Judge** (`judge.ts`). Pass A lists observable evidence, each item citing a screenshot, a view line, the manifest, the sample or a Stage 2 check. Pass B gives each of the nine dimensions one of four levels, citing Pass A items. Several runs judge each artifact; each dimension takes the median level.
5. **Result** (`schema.ts`). One `studio-generation-quality-result-v1` JSON per generation, validated before it is written.

Only a live build that passed every gate, judged by a live judge on screenshots and code, is **comparable**. Imported folders, code-only evaluations and the plumbing judge are recorded but kept out of the primary statistics.

## Commands

```bash
# Check the pipeline on saved artifacts, spending nothing. The plumbing judge cites real
# evidence but its scores mean nothing.
npm run eval:studio-quality -- judge-only --from=tmp/product-bench4 --out=tmp/studio-quality/trial --judge=plumbing

# Summarise every result under a folder (writes report.json there).
npm run eval:studio-quality -- report --results=tmp/studio-quality/trial

# Live builds. Prints the plan and the cap and stops unless --yes is given.
npm run eval:studio-quality -- build --set=all --max-usd=15 --judge=<provider>:<model> --judge-reasoning=<setting> --yes
```

A live build needs `--max-usd` (a hard cap over building and judging), `--yes`, and only `GOOGLE_GENERATIVE_AI_API_KEY` in the environment. It refuses any Supabase secret, and it refuses to start if the builder's instructions, review instructions, model or thinking level differ from Step 11's (`freeze.ts`). Never run it with the root `.env` loaded.

Cases: `--case=ID[,ID]` or `--set=dev|holdout|variance|all`. Repeats for the variance cases reuse the baseline group: `--group=<id> --start-generation=2 --repeat=4`. Judging: `--judge-passes` (default 3) and `--allow-code-only` for a diagnostic evaluation when screenshots fail.

## Files

| File | What it holds |
|---|---|
| `rubric.ts` | The nine dimensions, their levels, evidence and what not to reward; scoring and the median |
| `cases.ts` | The 20 canonical requests, goals, hints, the five variance cases and six holdouts |
| `build.ts` | One live build; takes only the request text |
| `freeze.ts` | The Step 11 builder's accepted hashes, model and thinking level |
| `platform-card.ts` | What a plugin can do, derived from the platform's constants, for the judge |
| `capture.mjs`, `evidence.ts` | Screenshots and Stage 2 |
| `judge.ts` | The judge interface, the two-pass protocol, the scripted and plumbing judges |
| `gates.ts`, `evaluate.ts` | Gates, comparability, and one artifact to one result |
| `artifacts.ts` | Saved artifact folders, and the importer for Step 11 benchmark folders |
| `aggregate.ts` | Suite statistics, nondeterminism measures, baseline comparison |
| `run.ts` | The command line |

Tests: `src/__tests__/studio-quality-*.test.ts`. The contamination guards there fail if the builder changes, if production code imports this folder, or if a hint or goal reaches the model during a build.

## Holdout

Q07, Q10, Q13, Q15, Q17 and Q20 are a process holdout. While tuning Step 12, don't read their detailed results to decide changes, and don't tune against one of their failures. Report them only in aggregate.
