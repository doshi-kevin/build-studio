# e2e/

End-to-end testing. Three different kinds live here, because they answer different questions.

| Folder | What it is | Runs in CI |
|---|---|---|
| [`tests/`](./tests/) | Playwright specs. Assert on things you can express in code. | No, run by hand |
| [`visual/`](./visual/) | Browser walkthroughs Claude drives, one markdown file per feature. Check what a person actually sees. | No |
| [`load/`](./load/) | k6 load test for Live Classroom, 100 concurrent students. | No |

Unit tests are not here. They are Vitest, in `src/__tests__/`, and they are the ones CI runs on
every push.

Supporting files:

- `playwright.config.ts` is the shared config. Tests come from `./tests`, the base URL is
  `E2E_BASE_URL` or `http://localhost:3000`, and it starts a dev server itself if one is not
  already up.
- `global-setup.ts` seeds the database before the suite runs.
- `helpers/` holds login, database, invite, and test-id helpers. Use these rather than writing a
  fresh login flow in each spec.
- `fixtures/test-users.ts` holds the accounts the specs expect.
- `setup/broadcast-smoke.ts` is a quick realtime sanity check.

## Running the Playwright suite

You need a local Supabase stack and a `.env.test` file.

```bash
npm run db:seed:e2e   # seed the deterministic users and course data
npm run e2e           # run the suite
npm run e2e:ui        # run it in the Playwright UI, best for debugging one spec
```

The suite runs against local Supabase, never production. `.env.test` is what keeps it that way, so
check what it points at before running anything that writes.

## Two things here are currently broken

**`npm run db:seed:e2e` does not work against the current schema.** `scripts/seed-e2e.ts` never
sets `institution_id`, and `profiles` and `sections` now require it. Since
`playwright.config.ts` calls that seed from `global-setup.ts`, the shared harness fails before
your spec runs.

`playwright.todos.config.ts` is the workaround for one spec. It skips `globalSetup` entirely and
runs against the local dev seed data (`professor@scholera.dev` and `student3@scholera.dev`), which
is tenanted correctly, reusing whatever dev server is already on port 3000:

```bash
npx dotenv -e .env.test -- npx playwright test --config=e2e/playwright.todos.config.ts
```

That is a patch around the problem, not a fix. Fixing `seed-e2e.ts` to set `institution_id` would
make the shared harness work again and let that separate config go away.

**`npm run e2e:prep` is dead.** It calls `scripts/e2e-prep-local.sh`, which does not exist in the
repo and is not gitignored. Either the script was deleted without removing the npm script, or it
was never committed.

## Which kind of test to write

Write a **Playwright spec** when the thing you are checking can be asserted: a role cannot reach a
page, a submitted quiz produces the right score, an invite creates the right rows. These are
repeatable and catch regressions.

Write a **visual walkthrough** when the answer is a judgement call: does the layout hold up, is
the AI output any good, does a multi-step flow feel broken. Those are hard to assert and easy to
see. See [`visual/README.md`](./visual/README.md) for how to drive one.

Reach for a **load test** when the question is about capacity rather than correctness. See
[`load/load-README.md`](./load/load-README.md).
