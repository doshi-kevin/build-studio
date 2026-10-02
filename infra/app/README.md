# Deploy scripts

The scripts that put the Scholera app on Google Cloud Run. Three scripts and two Cloud Build
configs, all run by hand from the repo root.

| File | What it does |
|---|---|
| `deploy-to-prod.sh` | Deploys to production, the `scholera` service. |
| `deploy-to-staging.sh` | Deploys to staging, the `scholera-staging` service. |
| `setup-sweep-schedulers.sh` | Creates or updates the Cloud Scheduler jobs that drain the work queues. |
| `cloudbuild.yaml` | Build config used by `deploy-to-prod.sh`. |
| `cloudbuild.staging.yaml` | Build config used by `deploy-to-staging.sh`. |

**These scripts deploy code only.** They never run database migrations. Migrations are a
separate, deliberate step. If your change needs a new migration or a new env var, that has to be
in place *before* you deploy, or the new code will land on a database or a config that cannot
support it.

The two scripts treat environment variables differently:

- `deploy-to-prod.sh` passes no env flags, so production keeps whatever is set on the service.
  Change a variable with `gcloud run services update scholera --region us-central1
  --update-env-vars NAME=value` (or `--update-secrets` for a secret).
- `deploy-to-staging.sh` passes `--set-env-vars` and `--set-secrets`. Those flags remove every
  variable and every secret not in the script's list on each deploy
  ([gcloud run deploy](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy)). A variable
  set on `scholera-staging` by hand is gone after the next staging deploy. To keep one, add it to
  the script's lists.

## Production

```bash
bash infra/app/deploy-to-prod.sh
```

It refuses to run unless all of this is true:

- You are on `main`.
- Your working tree is clean and pushed to `origin/main`.
- `npm run lint` passes.
- `npm run typecheck` passes.
- The active gcloud account is the Scholera one (`patelharshil@scholera-inc.com`), not a personal
  Google account. If it is wrong, run `gcloud auth login`.

Those checks exist because everything they catch has shipped broken before. `--skip-checks`
exists for emergencies. If lint or typecheck fails, fix the failure rather than passing the flag.
`--dry-run` validates the config and prints what would happen without building anything, which is
the safe way to check a change to the script itself.

## Staging

```bash
bash infra/app/deploy-to-staging.sh [ENV_FILE] [--skip-checks] [--dry-run]
```

Staging is a hosted copy of production backed by a **completely separate Supabase project**. It
never touches the production database. It is where pull requests get QA'd before they go to prod.

It differs from the prod script in ways that are intentional:

- No branch, clean-tree, or push requirement, because the whole point is testing work in progress
  (usually the `staging` branch).
- It builds through `cloudbuild.staging.yaml` rather than deploying from source, because the
  staging Supabase URL and anon key have to be passed as build args and `gcloud run deploy
  --source` cannot do that.
- The staging `service_role` key comes from GCP Secret Manager at deploy time. It is never
  written into a build arg or an image layer.

`ENV_FILE` defaults to `.env.staging`. The staging Supabase project is on the free tier and gets
paused and rotated, so you can keep several profiles (`.env.staging`, `.env.staging.b`) and pass
whichever is live.

## Queue sweep schedulers

```bash
bash infra/app/setup-sweep-schedulers.sh
```

Creates or updates two Cloud Scheduler jobs, `jobs-worker-sweep` and `extraction-worker-sweep`,
which poke the app every 5 minutes so nothing sits in a queue forever. Safe to re-run.

It reads the kick URLs and the shared secret from the deployed `scholera` service at run time
instead of having them hardcoded, so **run it again after rotating that secret** or the schedulers
will authenticate with a stale one.

Needs the Cloud Scheduler API enabled: `gcloud services enable cloudscheduler.googleapis.com`.
Background on why this is not a GitHub Actions cron is in [`../README.md`](../README.md).

## Cloud Run settings

What the scripts set, and what only the live service can tell you:

| Setting | Production | Staging | Where it comes from |
|---|---|---|---|
| Request timeout | 900 s | 900 s | `--timeout` in both scripts |
| Memory and CPU | 4 GiB, 2 vCPU | 4 GiB, 2 vCPU | `--memory`, `--cpu` |
| Instances | 0 to 10 | 0 to 2 | `--min-instances`, `--max-instances` |
| CPU allocation | not set | not set | Live service only. Request-based (CPU only while a request is in flight) unless someone ran `--no-cpu-throttling` |
| Startup CPU boost | not set | not set | Live service only |
| Concurrency | not set | not set | Live service only |
| Sweep cadence | every 5 min, 600 s attempt deadline, no retries | no sweep | `setup-sweep-schedulers.sh`, which only targets `scholera` |

To read the live values (needs `gcloud` and the Scholera account):

```bash
gcloud run services describe scholera --region us-central1 --format=export
gcloud run services describe scholera-staging --region us-central1 --format=export
gcloud scheduler jobs describe jobs-worker-sweep --location us-central1 --format=export
```

In the service export, `run.googleapis.com/cpu-throttling: 'false'` means instance-based CPU,
and its absence or `'true'` means request-based. `containerConcurrency`, `timeoutSeconds` and
`run.googleapis.com/startup-cpu-boost` are the other three.

## Environment for the Studio builder

The Studio builder (`docs/reference/studio-agent-harness.md`) runs on the background-jobs queue
and previews drafts on the plugin runtime origin. It has no variables of its own, but it does
nothing useful without these:

| Variable | What happens when it is missing |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | A build starts, then ends `failed` (`model_unavailable`) at its first model call. No request is sent |
| `BACKGROUND_JOBS_SECRET` | Builds are saved as `queued` but never run: no kick is sent, and the kick route answers 401 to everyone, the sweep included |
| `BACKGROUND_JOBS_KICK_URL` | The kick goes to `NEXT_PUBLIC_APP_URL` (or `VERCEL_URL`), else `http://localhost:3000`. Neither deploy script sets those two, so on Cloud Run it lands on localhost, the wrong port, and builds wait for the sweep. Staging has no sweep, so they wait until some other kick gets through |
| `STUDIO_RUNTIME_ORIGIN` | No draft preview. The professor sees "Previews aren't available here right now." |
| `STUDIO_FRAME_TICKET_SECRET` | The same. It must be at least 32 characters |

Three settings live elsewhere. The `studio` entitlement is per school, granted in the super-admin
plan editor. The "Studio Tool Builder" AI switch is per school or platform-wide, in the AI
settings; it is on unless someone turns it off. The model (`STUDIO_BUILDER_MODEL` in
`src/lib/ai/config.ts`) is a code constant, so staging can't override it.

Two traps:

- The kick URL must be on the app's host (`SITE_URL`), never on `STUDIO_RUNTIME_ORIGIN`. The
  runtime origin serves only plugin frames, so a kick sent there gets a 404. If the runtime
  origin is the service's own `*.run.app` URL, check that no kick URL or scheduler job uses that
  URL.
- On staging, all five have to go in `deploy-to-staging.sh` (the two secrets in
  `--set-secrets`, the rest in `--set-env-vars`), or the next deploy deletes them. Staging also
  needs its own sweep job before a lost kick can recover.

## If a deploy goes wrong

Cloud Run keeps every revision, so rolling back is a traffic change, not a rebuild:

```bash
gcloud run revisions list --service scholera --region us-central1
gcloud run services update-traffic scholera --region us-central1 \
  --to-revisions=<PREVIOUS_REVISION>=100
```

Rolling back the app does not roll back the database. A migration that already ran is still
applied, which is why migrations should work with both the old and the new code.
