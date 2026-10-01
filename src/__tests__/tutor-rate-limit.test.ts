// F1: the student Athena surface had no per-user cap, then borrowed the
// professor's. It now claims its own pool at its own cap through athena-core —
// no import from professor-assistant, and a cap a student body can't out-spend.
import { describe, it, expect, vi } from 'vitest'
import { reserveStudentSlot } from '@/lib/ai/athena-core/rate-limit'
import { STUDENT_LIMIT_SCOPE, studentModelDef } from '@/lib/ai/athena-core/models'

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const db = (result: { data?: unknown; error?: unknown }) => {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    rpc: vi.fn(async (_n: string, p: Record<string, unknown>) => {
      calls.push(p)
      return { data: result.data ?? null, error: result.error ?? null }
    }),
  }
}

describe('student rate limit (athena-core)', () => {
  it('spends the student cap in the tutor pool, not the professor cap', async () => {
    const d = db({ data: [{ accepted: true }] })
    const r = await reserveStudentSlot(d, { institutionId: 'i', userId: 'u' })

    expect(r.accepted).toBe(true)
    expect(d.calls).toHaveLength(1)
    expect(d.calls[0].p_cap).toBe(100)
    expect(d.calls[0].p_cap).toBeLessThan(150) // the professor cap it used to borrow
    expect(d.calls[0].p_scope).toBe(STUDENT_LIMIT_SCOPE)
    expect(d.calls[0].p_model_id).toBe(studentModelDef().id)
  })

  it('refuses at cap instead of failing over to the pricier model', async () => {
    const d = db({ data: [{ accepted: false }] })
    const r = await reserveStudentSlot(d, { institutionId: 'i', userId: 'u' })

    expect(r.accepted).toBe(false)
    expect(d.calls).toHaveLength(1) // no second attempt on another model
  })

  it('fails open when the counter itself errors', async () => {
    const d = db({ error: { message: 'rpc exploded' } })
    const r = await reserveStudentSlot(d, { institutionId: 'i', userId: 'u' })

    expect(r.accepted).toBe(true)
  })
})
