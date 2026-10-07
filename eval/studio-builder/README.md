# Studio builder eval

Three suites test the Studio builder (the agent that writes a plugin from a professor's request). Architecture: `docs/reference/studio-agent-harness.md`.

| Suite | Model | Runs in | Proves |
|---|---|---|---|
| `src/__tests__/studio-builder-harness.test.ts` | Scripted, one reply per turn | `npm run test` | The harness's own rules: pauses, budgets, repair limits, Stop, the draft compare-and-swap, refusals |
| `eval/studio-builder/run.ts` | The real Gemini model | `npm run eval:studio-builder` only | That the real model can do the job inside those rules |
| `eval/studio-builder/product.ts` | The real Gemini model | `npx tsx` only, see [The product benchmark](#the-product-benchmark) | That ordinary professor requests come out as tools that use the platform correctly (Step 11) |

The live eval and the product benchmark spend money. Neither is part of `npm run test` or CI.

## Running it

It needs `GOOGLE_GENERATIVE_AI_API_KEY` and no database. The script loads no env file: export the model key in the shell that runs it and nothing else. If the process has a Supabase secret (`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DATABASE_PASSWORD`, `SUPABASE_DB_URL` or `SUPABASE_MGMT_TOKEN`), it refuses to start before any model call (`guard.ts`), since on a developer machine that secret can be production's. Each case runs the real harness, draft gate and check worker against the in-memory run store, with a scripted professor who approves or declines each approval card and answers questions.

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

Cases M1 to M5 test project memory. Each seeds saved decisions into the in-memory store, or runs a first build whose suggestion the scripted professor approves, then runs a build that should respect them: a suggestion from the first build reaches the second and the student view stays small (M1), relevant decisions reach the prompt and unrelated ones don't (M2), a conflicting request gets a replacement suggestion while the old decision stays active until approval (M3), replacing the AI decision leaves the anonymity one active (M4), and a hostile course title and skill name never become a suggestion (M5). Every case also checks that no decision became active without the professor's approval.

Cases R1 to R3 test course material. Each searches a small fixed course held in memory instead of a database, and the real copy guard checks the pages the build saw. A request about this week's lecture searches and uses its topics without copying material students can't see yet (R1), a copy change searches nothing (R2), and a course page that gives orders becomes neither an instruction nor a saved decision (R3). They record named booleans only, like the memory cases.

The newest behaviour runs first, since the spend cap may not reach every case: the R cases, then the M cases, then the E cases.

Cases E8, E10 and E11 (repeated failure, Stop, draft conflict) can only be forced by a script. They run in the harness suite, not here. `cases.ts` names the test for each one.

## The baseline

`baseline.json` records one live run, so a later run can be compared with it. Per case it holds the expected and actual outcome, the end reason, whether it passed, model turns, tool calls, repair rounds, check runs, approval cards approved and declined, questions asked, approximate tokens (output tokens already include the reasoning tokens, so don't add the two), cost to the tenth of a cent, and the failing check ids of the final check. A memory case also records how many suggestions it raised and each memory check's name with a pass or fail; nothing it records quotes a decision. For the whole run it holds the model ids, the builder instructions version, the validator version and ruleset, the compiler id, the harness limits, the date, the git commit and whether the tree had uncommitted changes.

It never holds prompts, model replies or summaries, the request, questions or answers, generated source or manifests, or keys. `src/__tests__/studio-builder-eval-baseline.test.ts` checks that.

`--compare` fails only on outcome. A case that met its expected outcome in the baseline and misses it now is a regression, and so is any broken invariant. Changes in turns, tool calls, questions, approval cards, tokens, cost and failing check ids are printed as deltas. They never fail a run on their own, because a live model varies from run to run. A case missing from either side, or cut short by the spend cap, is listed as not compared. A baseline file in another format is refused before any case runs. If the model, instructions, validator, compiler or limits differ from the baseline's, the report says so first, since the numbers then measure that change.

The baseline is one sample, not a benchmark. A single run says whether each case can pass. It doesn't say how often.

The committed `baseline.json` was recorded on 2026-10-06 at instructions `studio-builder-l1-v12` with every live case: 17 ran, 16 met their outcome, no invariant failed, $2.30. M4 missed once (a sample-data field its manifest lacked, refused six times in a row) and passed when rerun alone.

## Refreshing it

Re-record after any change to the builder instructions, the model, the validator ruleset or the limits:

1. Run `npm run eval:studio-builder -- --compare` and read the report.
2. If the changes are intended, run `npm run eval:studio-builder -- --write-baseline`. It refuses `--case`, so every live case is in it.
3. Commit `baseline.json` with the change that caused it. Prefer recording from a clean tree, so its commit id matches the code that ran.

## The product benchmark

`product.ts` (Step 11) sends 13 ordinary professor requests from `product-cases.ts`, such as attendance, an office-hours queue, lecture flashcards and anonymous feedback. Some cases add a follow-up message, which builds on the draft the first build committed, like a professor's next message. Each case runs the real harness, checks, check worker and design review against the in-memory run store, with a scripted professor who approves every card and answers questions with the case's answer.

Each case has pass or fail criteria about the platform contract the tool must use: who writes what, which capability, whether students can change something. They never test exact code. Visual quality isn't scored here: people judge it from the saved screenshots.

```bash
STUDIO_BUILDER_RENDERER=local npx tsx --tsconfig eval/tsconfig.json eval/studio-builder/product.ts \
  --case=G-attendance,E-office-hours-queue --max-usd=3 --out=tmp/product-bench
```

- It needs `GOOGLE_GENERATIVE_AI_API_KEY` exported in the shell, and refuses to start with a Supabase secret in the environment, like the live eval.
- `--max-usd` (default 3) caps the whole run the same way. `--case` takes a comma-separated list; without it every case runs.
- With `STUDIO_BUILDER_RENDERER=local`, the design review gets screenshots from Playwright's Chromium (`npx playwright install chromium`). Without it, the review reads the code only.
- Under `--out` (default `tmp/product-bench`, gitignored) it writes, per case, both views, the manifest, the sample data, the final screenshots and `result.json`: status, cost, turns, review outcome and each criterion's pass or fail. `summary.json` covers the whole run. No prompt or model reply is kept.

It keeps no baseline. Compare two runs by reading their `summary.json` files.
