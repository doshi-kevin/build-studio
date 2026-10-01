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

**These scripts deploy code only.** They never run database migrations and never change
environment variables. Both of those are separate, deliberate steps. If your change needs a new
migration or a new env var, that has to be in place *before* you deploy, or the new code will
land on a database or a config that cannot support it.

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

## If a deploy goes wrong

Cloud Run keeps every revision, so rolling back is a traffic change, not a rebuild:

```bash
gcloud run revisions list --service scholera --region us-central1
gcloud run services update-traffic scholera --region us-central1 \
  --to-revisions=<PREVIOUS_REVISION>=100
```

Rolling back the app does not roll back the database. A migration that already ran is still
applied, which is why migrations should work with both the old and the new code.
