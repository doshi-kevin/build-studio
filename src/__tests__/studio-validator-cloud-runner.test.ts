/**
 * The production Stage 2 dispatcher (validator/cloud-runner.ts) against a fake Cloud Run
 * and Cloud Storage. What the real GCP calls do is not provable here (see
 * infra/validator-runner/README.md); this pins what the dispatcher sends and how it reads
 * what comes back: the image check, the write-once report URL, an execution that carries
 * no nonce, and every way a finished execution can end the run.
 */
import { createHash, createSign, generateKeyPairSync, createVerify } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const {
  REPORT_PUT_HEADERS,
  cloudConfig,
  collectCloudRuns,
  dispatchCloudRun,
  payloadObject,
  pinnedTo,
  reportObject,
  v4SignedUrl,
} = await import('@/lib/studio/validator/cloud-runner')
type CloudClient = import('@/lib/studio/validator/cloud-runner').CloudClient
type DispatchStore = import('@/lib/studio/validator/cloud-runner').DispatchStore
type CollectStore = import('@/lib/studio/validator/cloud-runner').CollectStore

const DIGEST = `sha256:${'a'.repeat(64)}`
const IMAGE = `us-docker.pkg.dev/p/r/runner@${DIGEST}`
const config = { project: 'p', region: 'us-central1', job: 'studio-validator', bucket: 'b', digest: DIGEST }
const ID = crypto.randomUUID()
const ARTIFACT = { manifest: { id: 'tool' }, studentBundle: 'student()', professorBundle: 'professor()' }
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

let objects: Map<string, string>
let cloud: CloudClient & { runs: Record<string, string>[]; signed: { object: string; method: string; headers: Record<string, string> }[] }
let dispatched: { id: string; payloadSha256: string; execution: string; image: string; callbackSha256: string } | null
let failures: { id: string; code: string }[]

function fakeCloud(over: Partial<CloudClient> = {}) {
  const runs: Record<string, string>[] = []
  const signed: { object: string; method: string; headers: Record<string, string> }[] = []
  return {
    runs,
    signed,
    jobImage: async () => IMAGE,
    upload: async (object: string, body: string) => {
      if (objects.has(object)) return false
      objects.set(object, body)
      return true
    },
    signedUrl: async (object: string, method: 'GET' | 'PUT', headers: Record<string, string>) => {
      signed.push({ object, method, headers })
      return `https://signed.example/${method}/${object}`
    },
    runJob: async (env: Record<string, string>) => {
      runs.push(env)
      return 'projects/p/locations/us-central1/jobs/studio-validator/executions/e1'
    },
    execution: async () => ({ state: 'succeeded' as const, image: IMAGE }),
    readObject: async (object: string) => objects.get(object) ?? null,
    ...over,
  }
}

const dispatchStore = (over: Partial<DispatchStore> = {}): DispatchStore => ({
  loadRun: async () => ({ id: ID, stage: 'runtime', status: 'pending', versionId: 'v', runnerMode: null }),
  loadArtifact: async () => ARTIFACT,
  dispatch: async (id, payloadSha256, execution, image, callbackSha256) => {
    dispatched = { id, payloadSha256, execution, image, callbackSha256 }
    return true
  },
  fail: async (id, code) => {
    failures.push({ id, code })
  },
  ...over,
})

beforeEach(() => {
  objects = new Map()
  cloud = fakeCloud()
  dispatched = null
  failures = []
})

describe('configuration', () => {
  it('needs every setting and a full image digest', () => {
    const env = {
      STUDIO_VALIDATOR_GCP_PROJECT: 'p', STUDIO_VALIDATOR_REGION: 'r', STUDIO_VALIDATOR_JOB: 'j', STUDIO_VALIDATOR_BUCKET: 'b', STUDIO_VALIDATOR_RUNNER_DIGEST: DIGEST,
    }
    expect(cloudConfig(env)).toEqual({ project: 'p', region: 'r', job: 'j', bucket: 'b', digest: DIGEST })
    expect(cloudConfig({ ...env, STUDIO_VALIDATOR_RUNNER_DIGEST: 'a'.repeat(64) })).toBeNull()
    expect(cloudConfig({ ...env, STUDIO_VALIDATOR_BUCKET: '' })).toBeNull()
  })

  it('an image is pinned only by exactly this digest', () => {
    expect(pinnedTo(IMAGE, DIGEST)).toBe(true)
    expect(pinnedTo('us-docker.pkg.dev/p/r/runner:latest', DIGEST)).toBe(false)
    expect(pinnedTo(`${IMAGE}0`, DIGEST)).toBe(false)
    expect(pinnedTo(null, DIGEST)).toBe(false)
  })
})

describe('dispatch', () => {
  it('uploads the payload, signs a GET for it and a write-once PUT for the report, and starts one execution without the nonce', async () => {
    expect(await dispatchCloudRun(ID, { cloud, config, store: dispatchStore() })).toBe('dispatched')
    const payload = objects.get(payloadObject(ID))!
    const { nonce, validationId } = JSON.parse(payload)
    expect(validationId).toBe(ID)
    expect(cloud.signed).toEqual([
      { object: payloadObject(ID), method: 'GET', headers: {} },
      { object: reportObject(ID), method: 'PUT', headers: REPORT_PUT_HEADERS },
    ])
    expect(REPORT_PUT_HEADERS['x-goog-if-generation-match']).toBe('0')
    expect(cloud.runs).toEqual([{ VALIDATION_ID: ID, PAYLOAD_URL: `https://signed.example/GET/${payloadObject(ID)}`, REPORT_URL: `https://signed.example/PUT/${reportObject(ID)}` }])
    expect(JSON.stringify(cloud.runs)).not.toContain(nonce)
    expect(dispatched).toEqual({ id: ID, payloadSha256: sha256(payload), execution: expect.stringContaining('/executions/'), image: IMAGE, callbackSha256: sha256(nonce) })
  })

  it('a job not deployed at the pinned digest ends the run without starting anything', async () => {
    cloud = fakeCloud({ jobImage: async () => 'us-docker.pkg.dev/p/r/runner:latest' })
    expect(await dispatchCloudRun(ID, { cloud, config, store: dispatchStore() })).toBe('error')
    expect(failures).toEqual([{ id: ID, code: 'runner_image_mismatch' }])
    expect(cloud.runs).toEqual([])
    expect(objects.size).toBe(0)
  })

  it('a run that isn’t a pending, undispatched runtime run is skipped', async () => {
    for (const run of [
      { id: ID, stage: 'static', status: 'pending', versionId: 'v', runnerMode: null },
      { id: ID, stage: 'runtime', status: 'running', versionId: 'v', runnerMode: null },
      { id: ID, stage: 'runtime', status: 'pending', versionId: 'v', runnerMode: 'local' },
    ]) {
      expect(await dispatchCloudRun(ID, { cloud, config, store: dispatchStore({ loadRun: async () => run }) })).toBe('skipped')
    }
    expect(cloud.runs).toEqual([])
  })

  it.each([
    ['the upload fails', { upload: async () => false }],
    ['the execution doesn’t start', { runJob: async () => null }],
  ])('ends the run as error when %s', async (_label, over) => {
    cloud = fakeCloud(over)
    expect(await dispatchCloudRun(ID, { cloud, config, store: dispatchStore() })).toBe('error')
    expect(failures).toEqual([{ id: ID, code: 'runner_unavailable' }])
    expect(dispatched).toBeNull()
  })
})

describe('collect', () => {
  const run = (over: Partial<{ createdAt: string; executionName: string | null; runnerImage: string | null }> = {}) => ({
    id: ID, createdAt: new Date().toISOString(), executionName: 'projects/p/locations/r/jobs/j/executions/e1', runnerImage: IMAGE, ...over,
  })
  const collect = (store: Partial<CollectStore>, over: Partial<CloudClient> = {}) => {
    const finish = vi.fn(async () => ({ ok: true }))
    const full: CollectStore = { listDispatched: async () => [run()], fail: async (id, code) => void failures.push({ id, code }), finish, ...store }
    return { finish, result: collectCloudRuns({ cloud: fakeCloud(over), config, store: full, now: Date.now }) }
  }

  it('a succeeded execution’s report goes to the server’s verdict', async () => {
    objects.set(reportObject(ID), JSON.stringify({ binding: { validationId: ID }, report: {} }))
    const { finish, result } = collect({})
    expect(await result).toEqual({ finished: 1, failed: 0, waiting: 0 })
    expect(finish).toHaveBeenCalledWith(ID, { binding: { validationId: ID }, report: {} })
  })

  it('a running execution is left for the next kick', async () => {
    const { finish, result } = collect({}, { execution: async () => ({ state: 'running', image: IMAGE }) })
    expect(await result).toEqual({ finished: 0, failed: 0, waiting: 1 })
    expect(finish).not.toHaveBeenCalled()
  })

  it.each([
    ['a failed execution, even with a report present (someone else wrote first)', { execution: async () => ({ state: 'failed' as const, image: IMAGE }) }, true, 'runner_failed'],
    ['a succeeded execution with no report', {}, false, 'no_report'],
    ['an execution on another image', { execution: async () => ({ state: 'succeeded' as const, image: 'us-docker.pkg.dev/p/r/runner:latest' }) }, true, 'runner_image_mismatch'],
  ])('%s ends the run as error and never reaches the verdict', async (_label, over, withReport, code) => {
    if (withReport) objects.set(reportObject(ID), JSON.stringify({ binding: {}, report: {} }))
    const { finish, result } = collect({}, over)
    expect(await result).toMatchObject({ failed: 1, finished: 0 })
    expect(failures).toEqual([{ id: ID, code }])
    expect(finish).not.toHaveBeenCalled()
  })

  it('a report that isn’t JSON is no report', async () => {
    objects.set(reportObject(ID), '{nope')
    const { finish, result } = collect({})
    await result
    expect(failures).toEqual([{ id: ID, code: 'no_report' }])
    expect(finish).not.toHaveBeenCalled()
  })

  it('a run past its window ends without looking at the execution', async () => {
    const execution = vi.fn()
    const { result } = collect({ listDispatched: async () => [run({ createdAt: new Date(Date.now() - 16 * 60_000).toISOString() })] }, { execution })
    await result
    expect(failures).toEqual([{ id: ID, code: 'callback_expired' }])
    expect(execution).not.toHaveBeenCalled()
  })

  it('one run throwing doesn’t stop the others', async () => {
    const other = crypto.randomUUID()
    objects.set(reportObject(other), JSON.stringify({ binding: {}, report: {} }))
    let calls = 0
    const { finish, result } = collect(
      { listDispatched: async () => [run(), { ...run(), id: other }] },
      { execution: async () => (calls++ === 0 ? Promise.reject(new Error('boom')) : { state: 'succeeded' as const, image: IMAGE }) },
    )
    expect(await result).toMatchObject({ finished: 1 })
    expect(finish).toHaveBeenCalledWith(other, expect.anything())
  })
})

describe('the V4 signed URL', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const sign = async (s: string) => createSign('RSA-SHA256').update(s).sign(privateKey, 'base64')

  it('signs the method, object, expiry and every header, so the holder can’t change any of them', async () => {
    let stringToSign = ''
    const url = await v4SignedUrl({
      bucket: 'b', object: reportObject(ID), method: 'PUT', headers: REPORT_PUT_HEADERS, expiresSec: 900,
      now: new Date('2026-10-02T12:00:00.000Z'), email: 'app@p.iam.gserviceaccount.com',
      sign: async (s) => {
        stringToSign = s
        return sign(s)
      },
    })
    const u = new URL(url)
    expect(u.host).toBe('storage.googleapis.com')
    expect(u.pathname).toBe(`/b/runs/${ID}/report.json`)
    expect(u.searchParams.get('X-Goog-SignedHeaders')).toBe('content-type;host;x-goog-if-generation-match')
    expect(u.searchParams.get('X-Goog-Expires')).toBe('900')
    expect(u.searchParams.get('X-Goog-Date')).toBe('20261002T120000Z')
    expect(u.searchParams.get('X-Goog-Credential')).toBe('app@p.iam.gserviceaccount.com/20261002/auto/storage/goog4_request')
    const signature = Buffer.from(u.searchParams.get('X-Goog-Signature')!, 'hex')
    expect(createVerify('RSA-SHA256').update(stringToSign).verify(publicKey, signature)).toBe(true)

    const canonical = ['PUT', `/b/runs/${ID}/report.json`, u.search.slice(1).replace(/&X-Goog-Signature=.*$/, ''),
      'content-type:application/json\nhost:storage.googleapis.com\nx-goog-if-generation-match:0\n', 'content-type;host;x-goog-if-generation-match', 'UNSIGNED-PAYLOAD'].join('\n')
    expect(stringToSign).toBe(['GOOG4-RSA-SHA256', '20261002T120000Z', '20261002/auto/storage/goog4_request', sha256(canonical)].join('\n'))
  })
})
