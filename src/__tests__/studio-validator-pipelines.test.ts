/**
 * The validator's background jobs (validator/pipelines.ts): a revalidation job pages until
 * it is done, out of time, or waiting on a cap, and the upkeep queues the continuation
 * without kicking itself. The cloud dispatch and collect logic is tested in
 * studio-validator-cloud-runner.test.ts; here only the wiring that ends a run when no
 * runner is configured.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/studio/db', () => ({ loadMinAcceptedRuleset: vi.fn(), finishValidation: vi.fn() }))
vi.mock('@/lib/studio/validator/service', () => ({
  STUDIO_VALIDATOR_RUNTIME_JOB: 'studio_validator_runtime',
  STUDIO_VALIDATOR_REVALIDATE_JOB: 'studio_validator_revalidate',
  REVALIDATE_SUBJECT: 'revalidate',
  finishRuntimeRun: vi.fn(),
  revalidateInstitutionPage: vi.fn(),
}))
vi.mock('@/lib/studio/validator/runtime-runner', () => ({ runnerMode: vi.fn() }))
vi.mock('@/lib/studio/validator/cloud-runner', () => ({
  cloudConfig: vi.fn(),
  collectCloudRuns: vi.fn(),
  dispatchCloudRun: vi.fn(),
  googleCloudClient: vi.fn(),
}))

const db = await import('@/lib/studio/db')
const { revalidateInstitutionPage } = await import('@/lib/studio/validator/service')
const { runnerMode } = await import('@/lib/studio/validator/runtime-runner')
const { dispatchCloudRun } = await import('@/lib/studio/validator/cloud-runner')
const { runRevalidation, continueRevalidations, validatorRuntimePipeline } = await import('@/lib/studio/validator/pipelines')
const STUDIO_VALIDATOR_REVALIDATE_JOB = 'studio_validator_revalidate'

const INSTITUTION = crypto.randomUUID()
const ADMIN = crypto.randomUUID()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.loadMinAcceptedRuleset).mockResolvedValue(2)
})

describe('a revalidation job', () => {
  it('works through every page in one run while time allows', async () => {
    vi.mocked(revalidateInstitutionPage)
      .mockResolvedValueOnce({ next: 25, checked: 3, waiting: false })
      .mockResolvedValueOnce({ next: null, checked: 1, waiting: false })
    expect(await runRevalidation(INSTITUTION, ADMIN, { minRuleset: 2 }, undefined)).toEqual({ next: null, minRuleset: 2, checked: 4, waiting: false })
    expect(vi.mocked(revalidateInstitutionPage).mock.calls.map((c) => c[2])).toEqual([0, 25])
  })

  it('stops where a cap was reached, to resume there', async () => {
    vi.mocked(revalidateInstitutionPage).mockResolvedValueOnce({ next: 31, checked: 6, waiting: true })
    expect(await runRevalidation(INSTITUTION, ADMIN, { offset: 25, minRuleset: 2 }, undefined)).toEqual({ next: 31, minRuleset: 2, checked: 6, waiting: true })
  })

  it('hands off before its drain’s time runs out', async () => {
    vi.mocked(revalidateInstitutionPage).mockResolvedValue({ next: 25, checked: 0, waiting: false })
    const result = await runRevalidation(INSTITUTION, ADMIN, { minRuleset: 2 }, 1_000_000, () => 1_000_000 - 30_000)
    expect(result).toMatchObject({ next: 25, waiting: false })
    expect(revalidateInstitutionPage).toHaveBeenCalledTimes(1)
  })

  it('starts over when the minimum was raised again while it ran', async () => {
    vi.mocked(db.loadMinAcceptedRuleset).mockResolvedValueOnce(3).mockResolvedValue(3)
    vi.mocked(revalidateInstitutionPage)
      .mockResolvedValueOnce({ next: null, checked: 1, waiting: false })
      .mockResolvedValueOnce({ next: null, checked: 1, waiting: false })
    expect(await runRevalidation(INSTITUTION, ADMIN, { offset: 50, minRuleset: 2 }, undefined)).toEqual({ next: null, minRuleset: 3, checked: 2, waiting: false })
    expect(vi.mocked(revalidateInstitutionPage).mock.calls.map((c) => c[2])).toEqual([50, 0])
  })

  it('a malformed offset starts from the beginning', async () => {
    vi.mocked(revalidateInstitutionPage).mockResolvedValue({ next: null, checked: 0, waiting: false })
    await runRevalidation(INSTITUTION, ADMIN, { offset: -4 }, undefined)
    await runRevalidation(INSTITUTION, ADMIN, { offset: '7' }, undefined)
    expect(vi.mocked(revalidateInstitutionPage).mock.calls.map((c) => c[2])).toEqual([0, 0])
  })
})

/** A stand-in for the admin client: the jobs the upkeep reads and the rows it inserts. */
function fakeAdmin(jobs: { institution_id: string; status: string; result: unknown; created_by: string | null }[], insertError: { code: string } | null = null) {
  const inserts: Record<string, unknown>[] = []
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: async () => ({ data: jobs, error: null }),
    insert: async (row: Record<string, unknown>) => {
      inserts.push(row)
      return { error: insertError }
    },
  }
  return { client: { from: () => query } as never, inserts }
}

describe('the revalidation upkeep', () => {
  it('queues a continuation for an institution whose newest job ended with more to do, as that job’s actor', async () => {
    const other = crypto.randomUUID()
    const { client, inserts } = fakeAdmin([
      { institution_id: INSTITUTION, status: 'done', result: { next: 25, minRuleset: 2 }, created_by: ADMIN },
      { institution_id: INSTITUTION, status: 'done', result: { next: 0, minRuleset: 1 }, created_by: ADMIN },
      { institution_id: other, status: 'done', result: { next: null }, created_by: ADMIN },
    ])
    expect(await continueRevalidations(client)).toBe(1)
    expect(inserts).toEqual([
      expect.objectContaining({ type: STUDIO_VALIDATOR_REVALIDATE_JOB, institution_id: INSTITUTION, params: { offset: 25, minRuleset: 2 }, subject_key: 'revalidate', created_by: ADMIN, status: 'pending' }),
    ])
  })

  it('leaves an institution alone while its newest job is still queued or running, or failed', async () => {
    const { client, inserts } = fakeAdmin([
      { institution_id: INSTITUTION, status: 'pending', result: null, created_by: ADMIN },
      { institution_id: INSTITUTION, status: 'done', result: { next: 25 }, created_by: ADMIN },
      { institution_id: crypto.randomUUID(), status: 'failed', result: { next: 25 }, created_by: ADMIN },
    ])
    expect(await continueRevalidations(client)).toBe(0)
    expect(inserts).toEqual([])
  })

  it('an already-active job for the institution (23505) is not an error', async () => {
    const { client } = fakeAdmin([{ institution_id: INSTITUTION, status: 'done', result: { next: 25 }, created_by: ADMIN }], { code: '23505' })
    expect(await continueRevalidations(client)).toBe(0)
  })
})

describe('the cloud dispatch job', () => {
  it('without a configured cloud runner, ends the run as error instead of leaving it pending', async () => {
    vi.mocked(runnerMode).mockReturnValue('unavailable')
    const id = crypto.randomUUID()
    await validatorRuntimePipeline.run({ validationId: id }, {} as never)
    expect(db.finishValidation).toHaveBeenCalledWith(id, expect.objectContaining({ status: 'error', error: expect.objectContaining({ code: 'runner_unavailable' }) }))
    expect(dispatchCloudRun).not.toHaveBeenCalled()
  })
})
