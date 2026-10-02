# Studio builder eval

Two suites test the Studio builder (the agent that writes a plugin from a professor's request). Architecture: `docs/reference/studio-agent-harness.md`.

| Suite | Model | Runs in | Proves |
|---|---|---|---|
| `src/__tests__/studio-builder-harness.test.ts` | Scripted, one reply per turn | `npm run test` | The harness's own rules: pauses, budgets, repair limits, Stop, the draft compare-and-swap, refusals |
| `eval/studio-builder/run.ts` | The real Gemini model | `npm run eval:studio-builder` only | That the real model can do the job inside those rules |

The live eval spends money. It is never part of `npm run test` or CI.

## Running it

It needs `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local` and no database. Each case runs the real harness, draft gate and check worker against the in-memory run store, with a scripted professor who approves or declines each approval card and answers questions.

```bash
npm run eval:studio-builder                               # every live case
npm run eval:studio-builder -- --case=E4-capability       # one case
npm run eval:studio-builder -- --max-usd=3                # total spend cap, default 5
npm run eval:studio-builder -- --json=tmp/builder-eval.json  # full per-case output, local only
npm run eval:studio-builder -- --compare                  # compare this run to baseline.json
npm run eval:studio-builder -- --write-baseline           # record baseline.json from this run
```

`--max-usd` is a hard cap on the whole run. Before every model call, the eval's gate adds the worst-case cost of one more call to what has been spent. If that would pass the cap, the call never happens. A case that starts too close to the cap is skipped. A case cut short this way ends `budget_exhausted` and is marked `cappedByEval`.

The process exits 1 when a hard invariant fails (a run that never ended, an unapproved capability, a file outside the two views, a capability outside the catalog), or when `--compare` finds a regression.

Cases E8, E10 and E11 (repeated failure, Stop, draft conflict) can only be forced by a script. They run in the harness suite, not here. `cases.ts` names the test for each one.

## The baseline

`baseline.json` records one live run, so a later run can be compared with it. Per case it holds the expected and actual outcome, the end reason, whether it passed, model turns, tool calls, repair rounds, check runs, approval cards approved and declined, questions asked, approximate tokens (output tokens already include the reasoning tokens, so don't add the two), cost to the tenth of a cent, and the failing check ids of the final check. For the whole run it holds the model ids, the builder instructions version, the validator version and ruleset, the compiler id, the harness limits, the date, the git commit and whether the tree had uncommitted changes.

It never holds prompts, model replies or summaries, the request, questions or answers, generated source or manifests, or keys. `src/__tests__/studio-builder-eval-baseline.test.ts` checks that.

`--compare` fails only on outcome. A case that met its expected outcome in the baseline and misses it now is a regression, and so is any broken invariant. Changes in turns, tool calls, questions, approval cards, tokens, cost and failing check ids are printed as deltas. They never fail a run on their own, because a live model varies from run to run. A case missing from either side, or cut short by the spend cap, is listed as not compared. A baseline file in another format is refused before any case runs. If the model, instructions, validator, compiler or limits differ from the baseline's, the report says so first, since the numbers then measure that change.

The baseline is one sample, not a benchmark. A single run says whether each case can pass. It doesn't say how often.

## Refreshing it

Re-record after any change to the builder instructions, the model, the validator ruleset or the limits:

1. Run `npm run eval:studio-builder -- --compare` and read the report.
2. If the changes are intended, run `npm run eval:studio-builder -- --write-baseline`. It refuses `--case`, so every live case is in it.
3. Commit `baseline.json` with the change that caused it. Prefer recording from a clean tree, so its commit id matches the code that ran.
