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

The env file needs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` and `STUDIO_RUNTIME_ORIGIN`. `NEXT_PUBLIC_SITE_URL` is optional and
defaults to `https://staging.scholera-inc.com`. The script refuses to deploy when the runtime
origin is missing or invalid, or when the file sets `STUDIO_STUDENT_ACCESS=on`. `--dry-run`
prints the Studio builder settings it would apply, and whether each builder secret already
exists. It still needs `gcloud` signed in, because the auth check runs first.

First-time setup, in this order:

1. Deploy staging once. That creates the `scholera-staging` service and the two builder secrets.
2. Run `bash infra/app/setup-sweep-schedulers.sh --staging` to create the staging sweep job.

Later deploys don't touch the sweep job. Re-run step 2 only if `staging-background-jobs-secret`
gets a new version or the staging `SITE_URL` changes.

## Queue sweep schedulers

```bash
bash infra/app/setup-sweep-schedulers.sh             # production
bash infra/app/setup-sweep-schedulers.sh --staging   # staging
```

With no argument it creates or updates four Cloud Scheduler jobs for the `scholera` service:
`jobs-worker-sweep` and `extraction-worker-sweep` poke the queue workers every 5 minutes so
nothing sits in a queue forever, `notifications-pulse` runs every 5 minutes, and `lc-deck-reaper`
runs daily at 03:00 UTC. Safe to re-run. Any other argument is refused, so a mistyped flag can't
fall through to the production jobs.

It reads the kick URLs and the shared secrets from the deployed `scholera` service at run time
instead of having them hardcoded, so **run it again after rotating a secret** or the schedulers
will authenticate with a stale one.

With `--staging` it creates or updates one job, `jobs-worker-sweep-staging`, for the
`scholera-staging` service. The other three jobs aren't created for staging, because the Studio
builder doesn't need them. The job:

- runs every 5 minutes (`*/5 * * * *`, UTC);
- sends a POST to the service's `BACKGROUND_JOBS_KICK_URL`, which must be
  `${SITE_URL}/api/jobs-worker/kick`, or the script stops;
- authenticates with the `x-background-jobs-secret` header. The value is read from Secret Manager
  (`staging-background-jobs-secret`), because staging injects that secret and the service env
  only holds a reference to it;
- has a 600-second attempt deadline and no retries.

A failed attempt isn't retried. The next tick, 5 minutes later, is the retry. Each tick also runs
the kick route's upkeep before it drains the queue. For the Studio builder that requeues a build
whose slice stalled or died (no heartbeat for 60 seconds), so the same drain picks it up, whether
or not the professor has the page open.

The script stops with a message if the staging service doesn't exist yet. Deploy staging first.

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
| Sweep cadence | every 5 min, 600 s attempt deadline, no retries | the same, background-jobs queue only | `setup-sweep-schedulers.sh`, and `--staging` for `scholera-staging` |

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

| Variable | What it is | Where staging gets it | What happens when it is missing |
|---|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | The Gemini key every AI feature uses | Secret Manager, `gemini-api-key`, shared with the rest of the app | A build starts, then ends `failed` (`model_unavailable`) at its first model call. No request is sent |
| `BACKGROUND_JOBS_SECRET` | The shared secret the kick route checks in the `x-background-jobs-secret` header | Secret Manager, `staging-background-jobs-secret`. Generated on the first deploy | Builds are saved as `queued` but never run: no kick is sent, and the kick route answers 401 to everyone, the sweep included |
| `BACKGROUND_JOBS_KICK_URL` | Where a new job's kick is sent | Set by the script to `${SITE_URL}/api/jobs-worker/kick` | The kick goes to `NEXT_PUBLIC_APP_URL` (or `VERCEL_URL`), else `http://localhost:3000`. Neither deploy script sets those two, so on Cloud Run it lands on localhost, the wrong port, and builds wait for the sweep |
| `STUDIO_RUNTIME_ORIGIN` | The separate origin that serves plugin frames and draft previews | The env file. Required | No draft preview. The professor sees "Previews aren't available here right now." |
| `STUDIO_FRAME_TICKET_SECRET` | Signs the short-lived ticket that lets the runtime origin serve one frame | Secret Manager, `staging-studio-frame-ticket-secret`. Generated on the first deploy | The same. It must be at least 32 characters |

The generated secrets are 64 random hex characters. The script holds the value from `openssl`
in a shell variable, checks its length, and pipes it into `gcloud secrets create`, so it is
never printed, written to disk or passed as a command-line argument. A deploy never rotates an
existing secret. To rotate one, add a version by hand
(`gcloud secrets versions add`), deploy staging so the service picks it up, and for the jobs
secret re-run `setup-sweep-schedulers.sh --staging`. Values for these two secrets or for
`BACKGROUND_JOBS_KICK_URL` in the env file are ignored.

The script checks `STUDIO_RUNTIME_ORIGIN` with the same rules the app applies
(`studioOrigins()` in `src/lib/studio/runtime/origin.ts`), and refuses to deploy if it fails one:

- it is `https`;
- it is a bare origin: a host name and an optional numeric port, with no path, query or
  fragment (`https://plugins.example.net`, not `https://plugins.example.net/frames`);
- its host is not the `SITE_URL` host, a subdomain of it, or a parent of it;
- it is on a different registrable domain from `SITE_URL`. A sibling such as
  `plugins.scholera-inc.com` next to `staging.scholera-inc.com` is the same site, so requests
  from a frame would carry the app's cookies (`docs/reference/studio-plugin-runtime.md`). The app
  can't check this one. The script compares the last two labels of each host, which can refuse a
  valid pair under a multi-label suffix such as `co.uk` but never lets a sibling through.

The app turns plugin frames off when any of the first three rules fails, so without these
checks a bad value would only show up as a missing preview. The service's own `*.run.app` URL is
a different site from `staging.scholera-inc.com` and works as the runtime origin. On that host
every path except plugin frames is a 404, so the deploy prints `SITE_URL` as the live URL and
labels the `*.run.app` URL as the runtime when the two match.

`STUDIO_STUDENT_ACCESS` stays off on staging. The script never sets it, so students reach no
plugin, and it refuses to deploy an env file that sets it to `on`. It opens only when the
release gate passes (`docs/reference/studio-plugin-publication.md#release-gate`).
`STUDIO_VALIDATOR_RUNNER` isn't set either: production builds refuse the local runner.

Three settings live elsewhere. The `studio` entitlement is per school, granted in the super-admin
plan editor. The "Studio Tool Builder" AI switch is per school or platform-wide, in the AI
settings; it is on unless someone turns it off. The model (`STUDIO_BUILDER_MODEL` in
`src/lib/ai/config.ts`) is a code constant, so staging can't override it.

The kick URL must be on the app's host (`SITE_URL`), never on `STUDIO_RUNTIME_ORIGIN`. The
runtime origin serves only plugin frames, so a kick sent there gets a 404. On staging,
`deploy-to-staging.sh` derives the kick URL from `SITE_URL`, and the sweep setup stops if the
service's value is anything else. In production, where variables are set by hand, check that no kick URL or scheduler job
uses the runtime origin.

`deploy-to-staging.sh` passes all five settings on every deploy (the three secrets in
`--set-secrets`, the kick URL and runtime origin in `--set-env-vars`), so the replace-everything
behaviour of those flags keeps them. A lost kick on staging is recovered by
`jobs-worker-sweep-staging` within 5 minutes.

## If a deploy goes wrong

Cloud Run keeps every revision, so rolling back is a traffic change, not a rebuild:

```bash
gcloud run revisions list --service scholera --region us-central1
gcloud run services update-traffic scholera --region us-central1 \
  --to-revisions=<PREVIOUS_REVISION>=100
```

Rolling back the app does not roll back the database. A migration that already ran is still
applied, which is why migrations should work with both the old and the new code.
