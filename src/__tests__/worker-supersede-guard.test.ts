// @vitest-environment node
//
// The extract path's supersede guard + content-write error handling (worker.ts).
// Two behaviours the existing worker tests can't reach — both use job.created_at
// = '' so the recency comparison is always NaN>NaN = false, and none exercises a
// rejected content write:
//   • isSupersededByNewer: a stale OLDER jobId (a crashed/dead job) must NOT block
//     us — the fix for the "poisoned row stuck at 'processing' forever" bug. A
//     strictly-NEWER jobId (a real re-upload race) still must.
//   • mergeContentExtraction now returns {ok,error}; a rejected jsonb write (e.g.
//     an un-stripped NUL) must fail the job loudly, not report a phantom success.
//
// Driven through the public runOneJob with an in-memory fake admin (the same
// pattern as worker-image-vision.test.ts) so the private guard is asserted via
// its real caller rather than by exporting internals.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import sharp from 'sharp'

// Keep the standalone-image vision pass offline. A plain controllable object (not
// a vi.fn) per the vitest-4 caution in CLAUDE.md — this one never throws, but we
// stay consistent with the sibling image test.
const visionUnits = {
  formulas: [{ pageNumber: 1, latex: 'a^2+b^2=c^2', kind: 'display' as const, source: 'vision' as const }],
  figures: [{ pageNumber: 1, description: 'a right triangle', source: 'vision' as const }],
  tables: [] as unknown[],
}
/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('@/lib/document-parser/vision', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/document-parser/vision')>()),
  runVisionOnImage: (async () => visionUnits) as unknown as typeof import('@/lib/document-parser/vision').runVisionOnImage,
}))
// Keep the best-effort topic/concept step offline: with no topics it never writes,
// so it can't interfere with what the supersede guard did (or didn't) persist.
vi.mock('@/lib/ai/llm-client', () => ({
  extractTopicsFromContent: vi.fn(async () => ({ topics: [], summary: null })),
  extractQuizConcepts: vi.fn(async () => null),
  CONCEPT_MIN_CONCEPTS: 3,
}))
// Keep the post-extract mastery recompute offline: it builds its own admin client via
// createAdminClient() instead of the mock handed to runOneJob, so the real one issues
// live requests against whatever SUPABASE_URL the env holds. Nothing here asserts on it.
vi.mock('@/lib/extraction/enqueue', () => ({ enqueueMasteryRecompute: vi.fn() }))

import { runOneJob } from '@/lib/extraction/worker'

let png: Buffer
beforeAll(async () => {
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
})

// One pending image extract job (created_at CUR) + one module_items row whose
// content.extraction the worker reads-modify-writes. `jobsById` answers the new
// isSupersededByNewer lookup against extraction_jobs; `writeError` makes every
// module_items content write reject (the un-stripped-NUL / jsonb-rejection case).
const CUR = '2026-01-02T00:00:00.000Z'
function makeAdmin(opts?: {
  seedExtraction?: Record<string, unknown>
  jobsById?: Record<string, string>
  writeError?: { message: string }
}) {
  const moduleItem = {
    id: 'mi1', title: 'Deck', item_type: 'lecture', module_id: 'mod1',
    content: {
      fileType: 'image', filePath: 'sec1/mi1/photo.png', fileSize: png.length,
      ...(opts?.seedExtraction ? { extraction: opts.seedExtraction } : {}),
    } as Record<string, unknown>,
  }
  const job = {
    id: 'job1', kind: 'extract', module_item_id: 'mi1', status: 'pending', attempts: 0, max_attempts: 3,
    payload: { sectionId: 'sec1' }, error: null, claimed_by: null, claim_expires_at: null,
    created_at: CUR, started_at: null, completed_at: null, heartbeat_at: null,
  }
  const jobsById = opts?.jobsById ?? {}
  let claimed = false
  const jobUpdates: Array<Record<string, unknown>> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = {
    rpc: async (name: string) => {
      if (name === 'claim_next_extraction_job' && !claimed) { claimed = true; return { data: job, error: null } }
      return { data: null, error: null }
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, val: string) => ({
          single: async () => {
            if (table === 'modules') {
              return { data: { section_id: 'sec1', course_sections: { institution_id: 'inst1' } }, error: null }
            }
            if (table === 'extraction_jobs') {
              return { data: jobsById[val] ? { created_at: jobsById[val] } : null, error: null }
            }
            // module_items — deep-copy so the worker's read can't alias our store
            return { data: { ...moduleItem, content: { ...moduleItem.content } }, error: null }
          },
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (obj: any) => ({
        eq: async () => {
          if (table === 'extraction_jobs') { jobUpdates.push(obj); return { error: null } }
          if (table === 'module_items') {
            if (opts?.writeError) return { error: opts.writeError }
            if (obj?.content) moduleItem.content = obj.content
          }
          return { error: null }
        },
      }),
    }),
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) }, error: null }),
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://x/i.png' } }),
      }),
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as unknown as SupabaseClient, jobUpdates, extraction: () => (moduleItem.content as any).extraction }
}

describe('worker — extract-path supersede guard (isSupersededByNewer)', () => {
  it('a stale OLDER jobId does not block the write (the poisoned-row fix)', async () => {
    // Row carries a jobId from a job created BEFORE us — a crashed/dead run. The
    // old `!== currentJobId` check would defer forever; the recency check writes.
    const { admin, extraction } = makeAdmin({
      seedExtraction: { jobId: 'dead-old-job', status: 'processing', pages: [] },
      jobsById: { 'dead-old-job': '2026-01-01T00:00:00.000Z' }, // < CUR
    })

    const res = await runOneJob({ adminClient: admin, workerId: 'w' })

    expect(res.finalStatus).toBe('completed')
    // Our result landed — the stale jobId did not poison the row.
    expect(extraction().status).toBe('completed')
    expect(extraction().jobId).toBe('job1')
    expect(extraction().formulas?.[0]).toMatchObject({ source: 'vision' })
  })

  it('defers to a strictly NEWER jobId — never overwrites the newer run', async () => {
    // A newer re-upload landed while we ran (created_at AFTER us): we must skip.
    const { admin, extraction } = makeAdmin({
      seedExtraction: { jobId: 'newer-job', status: 'held-by-newer', pages: [{ pageNumber: 1, text: 'newer' }] },
      jobsById: { 'newer-job': '2026-01-03T00:00:00.000Z' }, // > CUR
    })

    const res = await runOneJob({ adminClient: admin, workerId: 'w' })

    // Not our row → deliberately not a failure, but nothing of ours was written.
    expect(res.finalStatus).not.toBe('failed')
    expect(extraction().jobId).toBe('newer-job')
    expect(extraction().status).toBe('held-by-newer')
    expect(extraction().formulas).toBeUndefined() // our vision units never stamped
  })

  it('an unknown recorded jobId (deleted / legacy row) is safe to write', async () => {
    // extraction_jobs has no row for the recorded id → no created_at → not newer.
    const { admin, extraction } = makeAdmin({
      seedExtraction: { jobId: 'ghost-job', status: 'processing', pages: [] },
      jobsById: {}, // lookup returns null
    })

    const res = await runOneJob({ adminClient: admin, workerId: 'w' })

    expect(res.finalStatus).toBe('completed')
    expect(extraction().jobId).toBe('job1')
  })
})

describe('worker — content-write error propagation (mergeContentExtraction)', () => {
  it('a rejected content write fails the job loudly (no phantom completed)', async () => {
    // Simulates Postgres rejecting the jsonb UPDATE (e.g. an un-stripped NUL).
    // Before the {ok,error} change this was swallowed → job reported success and
    // the item sat at 'processing' forever.
    const { admin } = makeAdmin({ writeError: { message: 'unsupported Unicode escape sequence' } })

    const res = await runOneJob({ adminClient: admin, workerId: 'w' })

    expect(res.finalStatus).toBe('failed')
    expect(res.error).toMatch(/unsupported Unicode escape sequence/)
  })
})
