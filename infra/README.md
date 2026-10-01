# Infrastructure

Scripts and config for deploying Scholera to Google Cloud Run.

```
infra/
├── app/                          # The main Scholera app
│   ├── README.md                 # How to run each of these, and what they guard against
│   ├── deploy-to-prod.sh         # Deploys the `scholera` service
│   ├── deploy-to-staging.sh      # Deploys the `scholera-staging` service
│   ├── setup-sweep-schedulers.sh # Creates the Cloud Scheduler queue-drain jobs
│   ├── cloudbuild.yaml           # Build config used by deploy-to-prod.sh
│   └── cloudbuild.staging.yaml   # Build config used by deploy-to-staging.sh
└── microservices/                # Supporting services, deployed separately
    └── deck-converter/           # Converts PowerPoint to PDF for Live Classroom
        ├── deploy.sh
        └── README.md             # Runbook: deploy, IAM, health checks, rollback
```

Local setup tooling (like `scripts/dev-setup/setup-local.sh`) lives under `scripts/`, not here.
This folder is only for deploying to the cloud.

## app/

The Scholera app is one deployable unit, not a set of microservices. It runs as the `scholera`
service in production and `scholera-staging` for staging.

- **Production:** `bash infra/app/deploy-to-prod.sh`. It will refuse to run unless you are on
  `main`, your tree is clean, and lint plus typecheck pass.
- **Staging:** `bash infra/app/deploy-to-staging.sh`, which builds through
  `cloudbuild.staging.yaml`.

Neither script applies database migrations or sets environment variables. Both are separate steps
you do first. Full details, including rollback, are in [`app/README.md`](./app/README.md).

### Queue sweeps

Two queues, background jobs and document extraction, drain through `/api/jobs-worker/kick` and
`/api/extraction-worker/kick`. The `enqueue` functions call those routes as soon as work arrives,
but that is best effort. The scheduled sweep is what guarantees nothing sits `pending` forever.

The sweep runs on Google Cloud Scheduler: two jobs, `jobs-worker-sweep` and
`extraction-worker-sweep`, in `us-central1`, every 5 minutes.

It used to run on GitHub Actions cron. That tied a core production guarantee to GitHub billing,
and when the billing lapsed the queues quietly stopped draining and nobody noticed. Cloud
Scheduler runs next to Cloud Run and does not care about GitHub. The old workflow files are still
there, but only for manual `workflow_dispatch` kicks.

- **Create or update the jobs:** `bash infra/app/setup-sweep-schedulers.sh`. Safe to re-run; it
  creates or updates. It reads each kick URL and the shared secret from the deployed `scholera`
  service at run time rather than having them hardcoded, so run it again after rotating the
  secret. Needs the Cloud Scheduler API turned on
  (`gcloud services enable cloudscheduler.googleapis.com`).
- **Force a drain right now:**
  `gcloud scheduler jobs run jobs-worker-sweep --location us-central1`.

## microservices/

Separate Cloud Run services that the app calls over authenticated HTTP. They stay out of the app
image so the image stays small and each service can scale, fail, and deploy on its own.

**deck-converter** runs Gotenberg, which is LibreOffice in a container, to turn Office documents
into PDF. The app's render pipelines only handle PDF, so this is what makes `.pptx` uploads work.
Since issue #182 it is the only office-conversion path we have. LibreOffice was removed from the
app image, so an untrusted deck is now parsed in this container instead of in the one serving
requests. The app finds it through the `GOTENBERG_URL` environment variable. If that variable is
unset, Office support switches itself off and PDF handling is unaffected. Details in its
[README](./microservices/deck-converter/README.md).

New standalone services go in `microservices/<name>/` with their own `deploy.sh` and `README.md`.
