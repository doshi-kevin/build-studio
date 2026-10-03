# Studio validator runner

The validator runner is where Stage 2 of the Studio plugin validator runs in production. Stage 2 executes a plugin's code in headless Chromium to measure layout, touch targets, accessibility, states and isolation (`docs/reference/studio-plugin-validator.md`). That code is untrusted, so it never runs in the Scholera app. It runs here: a Cloud Run job, `studio-validator-runner`, with one fresh container per validation.

| File | What it is |
|---|---|
| `Dockerfile` | The image: the Playwright base image pinned by digest, plus `validator-runtime/dist` and nothing else |
| `deploy.sh` | Creates or updates everything below. Dry run by default |
| `../../validator-runtime/build.mjs` | Builds `validator-runtime/dist`: the runner as one plain JavaScript file, the prebuilt host page script, the runtime assets, axe and the Playwright driver |
| `../../validator-runtime/cloud-entry.mjs` | What the container runs |

## How one run works

1. The app uploads the payload to `gs://<project>-studio-validator/runs/<validationId>/payload.json`, write-once (`ifGenerationMatch=0`), so a second dispatch of the same run fails instead of replacing it. The payload holds the manifest, both bundles, the validation id and the run's nonce.
2. The app signs two URLs that expire in 15 minutes: a GET for the payload and a PUT for `report.json`. The PUT signature includes `x-goog-if-generation-match: 0`, so the report object can be written once.
3. The app starts an execution of the job with three environment overrides: `VALIDATION_ID`, `PAYLOAD_URL` and `REPORT_URL`.
4. The container downloads the payload (2 MiB at most), checks that it belongs to `VALIDATION_ID`, runs both views and PUTs `{ binding, report }`. The binding carries the validation id, the nonce, the SHA-256 of the payload bytes it received and the runtime version. The runner reports measurements. The server decides the verdict.
5. The container exits 0 only when the PUT succeeded. A 412 means something else wrote the report first. That, any other refused PUT and any network error exit 1, so the execution fails and the server ends the run as an error.

Logs hold at most 200 lines and 32 KiB per execution, and only fixed event words and numbers. They never contain the URLs, the payload or the report.

## Isolation, and what has been verified

Nothing in this folder has run on Google Cloud yet. The table says which properties were checked on a developer machine and which wait on a GCP project.

| Property | How it's enforced | Verified here | Needs GCP |
|---|---|---|---|
| Plugin code stays in the browser sandbox | The plugin runs only in Chromium's renderer, inside the real frame document and security policy, on two loopback origins | Yes. The runner e2e suite, and the built `dist/cloud-entry.mjs` run end to end on Windows with a fake Cloud Storage | |
| Fresh container per run | One execution per validation. `--tasks 1 --parallelism 1 --max-retries 0` | The flags are asserted against a stub `gcloud` | UNVERIFIED |
| No credentials | The runner's service account `studio-validator-runner@` has no IAM roles and no keys. `deploy.sh` stops if it finds a project role binding or a key. No secrets or env vars are set on the job | The flags and checks are asserted against the stub | UNVERIFIED |
| No internet access | Direct VPC egress with `--vpc-egress all-traffic` into a subnet with no Cloud NAT. A private DNS zone answers every `*.googleapis.com` name with `restricted.googleapis.com` (199.36.153.4/30), with a route to that range. The egress firewall allows only tcp:443 to that range at priority 100 and denies everything at 65000. Playwright's in-browser blocking stays on as a second layer | Browser layer yes. The commands are asserted against the stub | UNVERIFIED: VPC, DNS, route and firewall |
| Non-root | The image runs as the base image's `pwuser` (uid 1001) | Dockerfile review only. No Docker on this machine | UNVERIFIED |
| Chromium sandbox on | `chromiumSandbox: true`. If the sandbox can't start, launch fails and the run ends as an error. `--no-sandbox` is never used, and a test fails if it appears in the deploy commands or the Dockerfile | Yes, locally | UNVERIFIED: whether the sandbox starts on Cloud Run gen2 as `pwuser`. Playwright's docs describe the seccomp and user setup Docker needs. Cloud Run gen2's behaviour has not been tried |
| Bounded CPU, memory and time | 2 vCPU, 2 GiB, 240 s task timeout, plus the runner's own 180 s total and 30 s per view | Runner limits yes | UNVERIFIED: job limits |
| Pinned image | The base image is pinned by digest, and the job runs the built image by digest. The app checks the job's image against `STUDIO_VALIDATOR_RUNNER_DIGEST` before each run | `build.mjs` output yes | UNVERIFIED: the Docker build |

### Residual risk: Cloud Storage in any project

There is no VPC Service Controls perimeter. Without one, the restricted Google API address reaches Cloud Storage in every project, not just this one. Code that escaped Chromium could upload data through a URL an attacker signed in their own project. The metadata server is also reachable, but the runner's account holds no roles, so its token opens nothing. A perimeter needs an organization-level policy. It is a recorded follow-up, not something this script can set up.

### Who can read the signed URLs

Execution overrides, including both signed URLs, are visible to anyone with `run.executions.get` on the job and in Cloud Audit Logs. Those principals are inside the Stage 2 trust boundary. `deploy.sh` grants `roles/run.viewer` on the job only to the app's service account and `ADMIN_GROUP`. Project-wide roles such as Viewer, Editor and Owner also include that permission, and this script does not remove them. Review who holds them on the project.

Reading the URLs is still not a quiet way to forge a pass. If someone PUTs a report first, the real runner's write fails with 412, the execution fails and the run ends as an error.

## Deploying

Running `deploy.sh` with `--apply` is a deployment. Get approval first.

You need `gcloud` signed in with rights to create these resources, and Node with this repository's dependencies installed (`npm ci`).

```bash
export APP_SERVICE_ACCOUNT=<the app's service account email>
export PLAYWRIGHT_IMAGE_DIGEST=<64 hex digits of mcr.microsoft.com/playwright:v1.61.0-noble>
export ADMIN_GROUP=<google group email that may read executions>

# 1. Dry run: prints every command, calls nothing.
bash infra/validator-runner/deploy.sh --project <project-id>

# 2. Apply. --project must be given on the command line.
bash infra/validator-runner/deploy.sh --apply --project <project-id> [--region us-central1]
```

Find the base image digest with `docker buildx imagetools inspect mcr.microsoft.com/playwright:v1.61.0-noble` or on the Microsoft Artifact Registry page. Keep it on the same Playwright version as `package-lock.json`, because `build.mjs` copies the lockfile's `playwright-core` into the image and it must match the browsers in the base image.

The script is safe to re-run. It creates what is missing, brings firewall rules, DNS records, the subnet and the bucket back to the settings above, and deploys a new image each time.

It creates:

- the Artifact Registry repository `studio-validator`, and the image built by Cloud Build;
- the service account `studio-validator-runner@<project>.iam.gserviceaccount.com`, with no roles;
- the network `studio-validator-vpc` and subnet `studio-validator-subnet` (Private Google Access on, no Cloud NAT);
- the private DNS zone `studio-validator-googleapis`, the route `studio-validator-restricted-vip` and two egress firewall rules;
- the bucket `gs://<project>-studio-validator` (uniform access, public access prevention, objects deleted after a day);
- the job `studio-validator-runner`;
- on the job, `roles/run.jobsExecutorWithOverrides` and `roles/run.viewer` for the app's service account and `roles/run.viewer` for `ADMIN_GROUP`; on the bucket, `roles/storage.objectAdmin` for the app's service account; and `roles/iam.serviceAccountTokenCreator` for the app's service account on itself, so it can sign URLs without a key file.

## App configuration

`deploy.sh` prints these values at the end. Set them on the Scholera app's Cloud Run service:

| Variable | Value |
|---|---|
| `STUDIO_VALIDATOR_RUNNER` | `cloud` |
| `STUDIO_VALIDATOR_GCP_PROJECT` | the project ID |
| `STUDIO_VALIDATOR_REGION` | the region, `us-central1` by default |
| `STUDIO_VALIDATOR_JOB` | `studio-validator-runner` |
| `STUDIO_VALIDATOR_BUCKET` | `<project>-studio-validator` |
| `STUDIO_VALIDATOR_RUNNER_DIGEST` | the image digest, `sha256:` followed by 64 hex digits |

None of these are secrets. The app reaches Google Cloud with its own service account.
