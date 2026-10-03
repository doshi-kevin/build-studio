// @vitest-environment node
// infra/validator-runner/deploy.sh against a stub gcloud that records every call. It
// asserts the isolation settings the runner depends on are actually in the commands:
// the job runs by digest with no retries, one task, gen2 and all egress through the
// no-NAT network; the network reaches only the restricted Google API range; the bucket
// is private with a one-day lifecycle; the app's grants are job-level. Running against
// real GCP is a separate, unverified step (README.md in that folder).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const hasBash = process.platform === 'win32' ? existsSync(BASH) : spawnSync('bash', ['-c', 'true']).status === 0
const SCRIPT = join(process.cwd(), 'infra', 'validator-runner', 'deploy.sh')
const DIGEST = 'sha256:' + 'b'.repeat(64)
const APP_SA = 'scholera-app@test-proj.iam.gserviceaccount.com'

const temps: string[] = []
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })))

const FAKE_GCLOUD = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *"artifacts docker images describe"*) echo "${DIGEST}"; exit 0 ;;
  *"auth list"*) echo "deployer@example.com"; exit 0 ;;
  *" describe "*) exit 1 ;;
esac
exit 0
`
// Stands in for \`node validator-runtime/build.mjs --out DIR\`: makes the entry file the
// script checks for, without building.
const FAKE_NODE = `#!/bin/sh
printf 'node %s\\n' "$*" >> "$FAKE_LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = "--out" ]; then mkdir -p "$2" && : > "$2/cloud-entry.mjs"; fi
  shift
done
exit 0
`

function deploy(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'validator-infra-'))
  temps.push(dir)
  const bin = join(dir, 'bin')
  spawnSync(BASH, ['-c', `mkdir -p "$1"`, '_', bin])
  writeFileSync(join(bin, 'gcloud'), FAKE_GCLOUD, { mode: 0o755 })
  writeFileSync(join(bin, 'node'), FAKE_NODE, { mode: 0o755 })
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  const result = spawnSync(BASH, [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: dir,
      NODE_ENV: 'test',
      FAKE_LOG: log,
      APP_SERVICE_ACCOUNT: APP_SA,
      PLAYWRIGHT_IMAGE_DIGEST: 'a'.repeat(64),
      ADMIN_GROUP: 'studio-admins@example.com',
    },
  })
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls }
}

const MUTATING = /\b(create|deploy|update|add-iam-policy-binding|enable|submit|delete|set)\b/

describe.skipIf(!hasBash)('validator runner deploy.sh', () => {
  const run = hasBash ? deploy(['--apply', '--project', 'test-proj']) : { status: null, stdout: '', stderr: '', calls: [] as string[] }
  const find = (re: RegExp) => run.calls.filter((c) => re.test(c))

  it('completes against the stub', () => {
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  it('deploys the job by digest with the isolation limits and the runner service account', () => {
    const [job] = find(/^run jobs deploy studio-validator-runner /)
    expect(job).toBeDefined()
    expect(job).toContain(`--image=us-central1-docker.pkg.dev/test-proj/studio-validator/runner@${DIGEST}`)
    for (const flag of ['--max-retries=0', '--parallelism=1', '--tasks=1', '--task-timeout=240s', '--vpc-egress=all-traffic', '--execution-environment=gen2', '--cpu=2', '--memory=2Gi', '--service-account=studio-validator-runner@test-proj.iam.gserviceaccount.com', '--network=studio-validator-vpc', '--subnet=studio-validator-subnet']) {
      expect(job).toContain(flag)
    }
    expect(run.calls.join('\n')).not.toMatch(/set-secrets|set-env-vars|update-secrets|no-sandbox/)
    expect(readFileSync(join(process.cwd(), 'infra', 'validator-runner', 'Dockerfile'), 'utf8')).not.toContain('no-sandbox')
  })

  it('builds the image from the pinned base and resolves it to a digest', () => {
    expect(find(/^node .*validator-runtime\/build\.mjs --out /)).toHaveLength(1)
    expect(find(/^builds submit /)).toHaveLength(1)
    expect(find(/^artifacts docker images describe .*image_summary\.digest/)).toHaveLength(1)
    expect(run.stdout).toContain(`STUDIO_VALIDATOR_RUNNER_DIGEST=${DIGEST}`)
  })

  it('creates the runner service account and checks it holds no roles', () => {
    expect(find(/^iam service-accounts create studio-validator-runner /)).toHaveLength(1)
    expect(find(/^projects get-iam-policy test-proj .*serviceAccount:studio-validator-runner@test-proj/)).toHaveLength(1)
    expect(find(/add-iam-policy-binding .*studio-validator-runner@/)).toHaveLength(0)
  })

  it('allows only tcp:443 to the restricted VIP and denies all other egress', () => {
    const [allow] = find(/^compute firewall-rules create studio-validator-allow-google-apis /)
    expect(allow).toMatch(/--direction=EGRESS .*--action=ALLOW .*--rules=tcp:443 .*--destination-ranges=199\.36\.153\.4\/30 .*--priority=100/)
    const [deny] = find(/^compute firewall-rules create studio-validator-deny-all-egress /)
    expect(deny).toMatch(/--direction=EGRESS .*--action=DENY .*--rules=all .*--destination-ranges=0\.0\.0\.0\/0 .*--priority=65000/)
    expect(find(/^compute routes create .*--destination-range=199\.36\.153\.4\/30 .*--next-hop-gateway=default-internet-gateway/)).toHaveLength(1)
    expect(find(/^compute networks subnets create .*--enable-private-ip-google-access/)).toHaveLength(1)
  })

  it('maps googleapis.com to restricted.googleapis.com in a private zone, with no Cloud NAT', () => {
    expect(find(/^dns managed-zones create .*--dns-name=googleapis\.com\. .*--visibility=private .*--networks=studio-validator-vpc/)).toHaveLength(1)
    expect(find(/^dns record-sets create \*\.googleapis\.com\. --type=CNAME .*--rrdatas=restricted\.googleapis\.com\./)).toHaveLength(1)
    expect(find(/^dns record-sets create restricted\.googleapis\.com\. --type=A .*--rrdatas=199\.36\.153\.4,199\.36\.153\.5,199\.36\.153\.6,199\.36\.153\.7/)).toHaveLength(1)
    expect(find(/routers nats create/)).toHaveLength(0)
    expect(find(/^compute routers list .*network:studio-validator-vpc/)).toHaveLength(1)
  })

  it('makes the bucket private with uniform access and a one-day delete rule', () => {
    expect(find(/^storage buckets create gs:\/\/test-proj-studio-validator .*--uniform-bucket-level-access .*--public-access-prevention/)).toHaveLength(1)
    expect(find(/^storage buckets update gs:\/\/test-proj-studio-validator .*--uniform-bucket-level-access .*--lifecycle-file=/)).toHaveLength(1)
    expect(run.stdout).not.toContain('allUsers')
  })

  it('grants the app only job-level and bucket-level roles, plus token creator on itself', () => {
    const grants = find(/add-iam-policy-binding/)
    expect(grants).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^run jobs add-iam-policy-binding studio-validator-runner .*serviceAccount:${APP_SA} --role=roles/run\\.jobsExecutorWithOverrides`)),
        expect.stringMatching(new RegExp(`^run jobs add-iam-policy-binding studio-validator-runner .*serviceAccount:${APP_SA} --role=roles/run\\.viewer`)),
        expect.stringMatching(/^run jobs add-iam-policy-binding studio-validator-runner .*group:studio-admins@example\.com --role=roles\/run\.viewer/),
        expect.stringMatching(new RegExp(`^storage buckets add-iam-policy-binding gs://test-proj-studio-validator .*serviceAccount:${APP_SA} --role=roles/storage\\.objectAdmin`)),
        expect.stringMatching(new RegExp(`^iam service-accounts add-iam-policy-binding ${APP_SA} .*serviceAccount:${APP_SA} --role=roles/iam\\.serviceAccountTokenCreator`)),
      ]),
    )
    expect(grants).toHaveLength(5)
    expect(find(/^projects add-iam-policy-binding/)).toHaveLength(0)
  })

  it('makes no gcloud call at all in a dry run', () => {
    const dry = deploy(['--project', 'test-proj'])
    expect(dry.status).toBe(0)
    expect(dry.calls.filter((c) => MUTATING.test(c))).toEqual([])
    expect(dry.calls).toEqual([])
    expect(dry.stdout).toContain('Dry run')
  })

  it('refuses --apply without an explicit --project', () => {
    const r = deploy(['--apply'])
    expect(r.status).not.toBe(0)
    expect(r.calls).toEqual([])
  })
})
