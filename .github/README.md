# .github/

GitHub configuration: one CI workflow, three scheduled or manual job-runners, and Dependabot.

## CI

`workflows/ci.yml` runs on every push and every pull request to `main`, in this order:

1. `npm run lint`
2. `npm run typecheck`
3. `npm run build`
4. `npm run test` (the Vitest unit suite, roughly 3,600 tests)

A newer run cancels an older one on the same branch. The whole thing takes 7 to 8 minutes with npm
caching on, and the timeout is 20 minutes. It used to be 10, which left so little headroom that as
the test suite grew, runs started getting killed mid-tests. A timeout kill shows up as a red
failure that looks exactly like a real assertion failure, which wasted time. 20 minutes still
catches a genuine hang.

CI builds with placeholder values for `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. That is safe on purpose: `NEXT_PUBLIC_` variables are designed to
be visible in the browser, and CI only needs the build to succeed. Real values are injected at
deploy time. No secret belongs in this file.

Playwright and the visual walkthroughs do not run in CI. Only unit tests do.

## The sweep workflows are manual only

`workflows/jobs-sweep.yml` and `workflows/extraction-sweep.yml` have no schedule. They are
`workflow_dispatch` only, useful for forcing a queue drain from the GitHub UI.

Both used to run on a GitHub cron. That made a core production guarantee, work queues actually
draining, depend on GitHub Actions billing. When the billing lapsed, every workflow stopped, the
queues quietly stopped draining, and nothing alerted. The schedule now lives on Google Cloud
Scheduler, next to Cloud Run, provisioned by `infra/app/setup-sweep-schedulers.sh`.

**Do not add a `schedule:` block back to these two.** You would end up with two things sweeping the
same queues, and you would reintroduce the dependency that caused the outage.

## One workflow still runs on GitHub's cron

`workflows/mastery-recompute-nightly.yml` runs at 02:00 UTC daily and POSTs to
`/api/skills/recompute-sweep`, authenticating with the same `x-extraction-worker-secret` header the
other workers use. It reads `MASTERY_RECOMPUTE_SWEEP_URL` and `EXTRACTION_WORKER_SECRET` from
repository secrets.

Worth knowing: this one carries exactly the risk that got the other two moved. If Actions billing
lapses again, mastery recomputation stops silently. Moving it to Cloud Scheduler alongside the
others would close that gap.

## Dependabot

`dependabot.yml` opens pull requests every Monday for npm packages (up to 10) and GitHub Actions
versions (up to 5). Minor and patch updates are grouped into one pull request each for production
and development dependencies, so the usual Monday result is a few PRs rather than thirty. Major
version bumps come through individually, because they need reading.

Everything gets a `dependencies` label. Actions bumps also get `github-actions`.

Dependabot PRs go through the same CI as anything else, and a green CI here means lint, types,
build, and unit tests pass. It does not mean the app was exercised in a browser.
