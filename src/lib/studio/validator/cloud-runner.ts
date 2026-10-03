/**
 * The production Stage 2 runner's dispatcher (docs/reference/studio-plugin-validator.md,
 * "The production runner"). One Cloud Run Job execution runs one validation:
 *
 *   start (the studio_validator_runtime job)
 *     check the job's image is the pinned digest, build the payload with a fresh nonce,
 *     upload it, sign a GET URL for it and a write-once PUT URL for the report, start one
 *     execution with only those URLs and the validation id, then record the dispatch.
 *   collect (the pipeline's upkeep, on every jobs kick)
 *     for each dispatched run, read the execution: failed, or finished without a report,
 *     ends the run as error; a report from a succeeded execution on the pinned image goes
 *     to the server's verdict (service.finishRuntimeRun), which checks its binding.
 *
 * The nonce is created here and never stored anywhere a person can read: it goes into the
 * payload object (readable only through the signed URL) and its hash into the run. The
 * runner exits non-zero if its write-once PUT fails, so a report written by anyone else
 * first makes the execution fail and the run end as error, never pass.
 *
 * Every external call goes through CloudClient, so the logic is tested with a fake. The
 * real client below talks to Cloud Run Admin v2 and Cloud Storage over REST with the app's
 * own service account (google-auth-library). It has not run against GCP from this repo:
 * see infra/validator-runner/README.md for what is verified and what isn't.
 */
import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { GoogleAuth } from 'google-auth-library'
import { logger } from '@/lib/logger'
import { STUDIO_VALIDATOR_CALLBACK_TTL_MS } from '../limits'
import { buildPayload, type RunnerArtifact } from './runtime-runner'

export interface CloudConfig {
  project: string
  region: string
  job: string
  bucket: string
  /** The full image digest the job must run, "sha256:<64 hex>". */
  digest: string
}

export function cloudConfig(env: Record<string, string | undefined> = process.env): CloudConfig | null {
  const c = {
    project: env.STUDIO_VALIDATOR_GCP_PROJECT ?? '',
    region: env.STUDIO_VALIDATOR_REGION ?? '',
    job: env.STUDIO_VALIDATOR_JOB ?? '',
    bucket: env.STUDIO_VALIDATOR_BUCKET ?? '',
    digest: env.STUDIO_VALIDATOR_RUNNER_DIGEST ?? '',
  }
  if (!c.project || !c.region || !c.job || !c.bucket || !/^sha256:[0-9a-f]{64}$/.test(c.digest)) return null
  return c
}

/** Whether an image reference is pinned to exactly this digest. */
export const pinnedTo = (image: string | null | undefined, digest: string) => typeof image === 'string' && image.endsWith(`@${digest}`)

export interface ExecutionState {
  state: 'running' | 'succeeded' | 'failed'
  image: string | null
}

export interface CloudClient {
  /** The image the job is deployed with, or null when it can't be read. */
  jobImage(): Promise<string | null>
  upload(object: string, body: string): Promise<boolean>
  signedUrl(object: string, method: 'GET' | 'PUT', headers: Record<string, string>, expiresSec: number): Promise<string>
  /** Starts one execution with these environment overrides; its full name, or null. */
  runJob(env: Record<string, string>): Promise<string | null>
  execution(name: string): Promise<ExecutionState | null>
  /** An object's text, or null when it doesn't exist or can't be read. */
  readObject(object: string): Promise<string | null>
}

export const payloadObject = (validationId: string) => `runs/${validationId}/payload.json`
export const reportObject = (validationId: string) => `runs/${validationId}/report.json`
/** The headers the runner's PUT carries; part of the V4 signature, so it can't send others. */
export const REPORT_PUT_HEADERS = { 'content-type': 'application/json', 'x-goog-if-generation-match': '0' }
const URL_TTL_SEC = Math.floor(STUDIO_VALIDATOR_CALLBACK_TTL_MS / 1000)

/** What the dispatcher needs from the database and the validator service. */
export interface DispatchStore {
  loadRun(validationId: string): Promise<{ id: string; stage: string; status: string; versionId: string; runnerMode: string | null } | null>
  loadArtifact(versionId: string): Promise<RunnerArtifact | null>
  dispatch(validationId: string, payloadSha256: string, execution: string, image: string, callbackSha256: string): Promise<boolean>
  fail(validationId: string, code: string, message: string): Promise<void>
}

export type DispatchOutcome = 'dispatched' | 'skipped' | 'error'

/** Start: one execution for one pending cloud run. */
export async function dispatchCloudRun(validationId: string, deps: { cloud: CloudClient; config: CloudConfig; store: DispatchStore }): Promise<DispatchOutcome> {
  const run = await deps.store.loadRun(validationId)
  if (!run || run.stage !== 'runtime' || run.status !== 'pending' || run.runnerMode !== null) return 'skipped'
  const fail = async (code: string, message: string) => {
    await deps.store.fail(validationId, code, message)
    logger.warn('studio/validator.dispatchCloudRun', { validationId, code })
    return 'error' as const
  }
  const image = await deps.cloud.jobImage()
  if (!pinnedTo(image, deps.config.digest)) return fail('runner_image_mismatch', 'The browser checks are being updated. Try again shortly.')
  const artifact = await deps.store.loadArtifact(run.versionId)
  if (!artifact) return fail('runner_failed', 'The browser checks didn’t finish.')

  const nonce = randomBytes(32).toString('base64url')
  const payload = buildPayload(validationId, nonce, artifact)
  if (!(await deps.cloud.upload(payloadObject(validationId), payload.bytes))) return fail('runner_unavailable', 'The browser checks couldn’t start. Try again shortly.')
  const [getUrl, putUrl] = await Promise.all([
    deps.cloud.signedUrl(payloadObject(validationId), 'GET', {}, URL_TTL_SEC),
    deps.cloud.signedUrl(reportObject(validationId), 'PUT', REPORT_PUT_HEADERS, URL_TTL_SEC),
  ])
  const execution = await deps.cloud.runJob({ VALIDATION_ID: validationId, PAYLOAD_URL: getUrl, REPORT_URL: putUrl })
  if (!execution) return fail('runner_unavailable', 'The browser checks couldn’t start. Try again shortly.')
  const recorded = await deps.store.dispatch(validationId, payload.sha256, execution, image!, createHash('sha256').update(nonce).digest('hex'))
  // A run that expired or changed meanwhile isn't recorded; its execution's report is never collected.
  if (!recorded) logger.warn('studio/validator.dispatchCloudRun: run changed before dispatch was recorded', { validationId })
  return recorded ? 'dispatched' : 'skipped'
}

/** What the collector needs. `finish` is the server's verdict path (service.finishRuntimeRun). */
export interface CollectStore {
  listDispatched(limit: number): Promise<{ id: string; createdAt: string; executionName: string | null; runnerImage: string | null }[]>
  fail(validationId: string, code: string, message: string): Promise<void>
  finish(validationId: string, envelope: unknown): Promise<{ ok: boolean }>
}

/** Collect: every dispatched cloud run whose execution has ended. Never throws. */
export async function collectCloudRuns(deps: { cloud: CloudClient; config: CloudConfig; store: CollectStore; now: () => number }): Promise<Record<string, number>> {
  const counts = { finished: 0, failed: 0, waiting: 0 }
  const runs = await deps.store.listDispatched(20)
  for (const run of runs) {
    try {
      if (deps.now() - new Date(run.createdAt).getTime() > STUDIO_VALIDATOR_CALLBACK_TTL_MS) {
        await deps.store.fail(run.id, 'callback_expired', 'The browser checks took too long.')
        counts.failed += 1
        continue
      }
      if (!run.executionName) continue
      const exec = await deps.cloud.execution(run.executionName)
      if (!exec || exec.state === 'running') {
        counts.waiting += 1
        continue
      }
      // The platform's own record of the image, not anything the runner says about itself.
      if (!pinnedTo(exec.image, deps.config.digest) || exec.image !== run.runnerImage) {
        await deps.store.fail(run.id, 'runner_image_mismatch', 'The browser checks ran on an unexpected runner.')
        counts.failed += 1
        continue
      }
      if (exec.state === 'failed') {
        await deps.store.fail(run.id, 'runner_failed', 'The browser checks didn’t finish.')
        counts.failed += 1
        continue
      }
      const body = await deps.cloud.readObject(reportObject(run.id))
      let envelope: unknown = null
      try {
        envelope = body ? JSON.parse(body) : null
      } catch {
        envelope = null
      }
      if (!envelope) {
        await deps.store.fail(run.id, 'no_report', 'The browser checks didn’t send a result.')
        counts.failed += 1
        continue
      }
      const done = await deps.store.finish(run.id, envelope)
      if (done.ok) counts.finished += 1
      else counts.failed += 1
    } catch (error) {
      logger.error('studio/validator.collectCloudRuns', error instanceof Error ? error.name : 'unknown', { validationId: run.id })
    }
  }
  return counts
}

// ── The real Google Cloud client ──

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * A Cloud Storage V4 signed URL (GOOG4-RSA-SHA256), signed by `sign` (IAM signBlob for the
 * app's service account). Every header in `headers` is part of the signature, so the
 * holder can't add or change one. Exported for its unit test.
 */
export async function v4SignedUrl(input: {
  bucket: string
  object: string
  method: 'GET' | 'PUT'
  headers: Record<string, string>
  expiresSec: number
  now: Date
  email: string
  sign: (stringToSign: string) => Promise<string>
}): Promise<string> {
  const datetime = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const scope = `${datetime.slice(0, 8)}/auto/storage/goog4_request`
  const host = 'storage.googleapis.com'
  const path = `/${input.bucket}/${input.object.split('/').map(enc).join('/')}`
  const headers: Record<string, string> = { host }
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim()
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const query: Record<string, string> = {
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${input.email}/${scope}`,
    'X-Goog-Date': datetime,
    'X-Goog-Expires': String(input.expiresSec),
    'X-Goog-SignedHeaders': signedHeaders,
  }
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&')
  const canonicalHeaders = names.map((k) => `${k}:${headers[k]}\n`).join('')
  const canonicalRequest = [input.method, path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['GOOG4-RSA-SHA256', datetime, scope, hex(canonicalRequest)].join('\n')
  const signature = Buffer.from(await input.sign(stringToSign), 'base64').toString('hex')
  return `https://${host}${path}?${canonicalQuery}&X-Goog-Signature=${signature}`
}

/** The Cloud Run Admin v2 / Cloud Storage client, authenticated as the app's service account. */
export function googleCloudClient(config: CloudConfig): CloudClient {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const jobPath = `projects/${config.project}/locations/${config.region}/jobs/${config.job}`
  const call = async <T>(opts: { url: string; method?: string; data?: unknown; headers?: Record<string, string>; responseType?: 'json' | 'text' }) => {
    const client = await auth.getClient()
    const res = await client.request<T>({ timeout: 15_000, ...opts })
    return res.data
  }
  return {
    async jobImage() {
      try {
        const job = await call<{ template?: { template?: { containers?: { image?: string }[] } } }>({ url: `https://run.googleapis.com/v2/${jobPath}` })
        return job.template?.template?.containers?.[0]?.image ?? null
      } catch {
        return null
      }
    },
    async upload(object, body) {
      try {
        await call({
          url: `https://storage.googleapis.com/upload/storage/v1/b/${enc(config.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${enc(object)}`,
          method: 'POST',
          data: body,
          headers: { 'content-type': 'application/json' },
        })
        return true
      } catch {
        return false
      }
    },
    async signedUrl(object, method, headers, expiresSec) {
      const credentials = await auth.getCredentials()
      if (!credentials.client_email) throw new Error('no service account email')
      return v4SignedUrl({ bucket: config.bucket, object, method, headers, expiresSec, now: new Date(), email: credentials.client_email, sign: (s) => auth.sign(s) })
    },
    async runJob(env) {
      try {
        const op = await call<{ metadata?: { name?: string } }>({
          url: `https://run.googleapis.com/v2/${jobPath}:run`,
          method: 'POST',
          data: { overrides: { containerOverrides: [{ env: Object.entries(env).map(([name, value]) => ({ name, value })) }], taskCount: 1 } },
        })
        return op.metadata?.name ?? null
      } catch {
        return null
      }
    },
    async execution(name) {
      try {
        const e = await call<{ completionTime?: string; succeededCount?: number; template?: { containers?: { image?: string }[] } }>({ url: `https://run.googleapis.com/v2/${name}` })
        const image = e.template?.containers?.[0]?.image ?? null
        if (!e.completionTime) return { state: 'running', image }
        return { state: (e.succeededCount ?? 0) >= 1 ? 'succeeded' : 'failed', image }
      } catch {
        return null
      }
    },
    async readObject(object) {
      try {
        return await call<string>({ url: `https://storage.googleapis.com/storage/v1/b/${enc(config.bucket)}/o/${enc(object)}?alt=media`, responseType: 'text' })
      } catch {
        return null
      }
    },
  }
}
