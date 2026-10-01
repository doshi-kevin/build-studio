// The live-classroom attendance join code (#82).
//
// Attendance used to be granted to any enrolled student who opened the room URL, so a student
// at home was marked present. The professor now shows a short code on the projector.
//
// The code gates ATTENDANCE, not the room — a student without it still sees the slides. What
// is worth pinning here is the handful of decisions that would be silently wrong:
//
//   * uniqueness is the database's job, not the generator's
//   * a reconnect must never re-ask for the code
//   * a short code is safe only because attempts are limited, so the limit must come BEFORE
//     the comparison and must not be cleared by a wrong guess

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  generateJoinCode,
  normalizeJoinCode,
  isWellFormedJoinCode,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
} from '@/lib/live-classroom/join-code'

describe('join code shape', () => {
  it('never contains a glyph that is misread on a projector', () => {
    /* O/0 and I/1/L are the pairs that get typed wrong from the back of a hall. */
    for (const bad of ['O', '0', 'I', '1', 'L']) {
      expect(JOIN_CODE_ALPHABET).not.toContain(bad)
    }
  })

  it('draws every character from that alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode()
      expect(code).toHaveLength(JOIN_CODE_LENGTH)
      expect([...code].every((c) => JOIN_CODE_ALPHABET.includes(c))).toBe(true)
    }
  })

  it('does not bias the alphabet by taking a raw modulo', () => {
    /* 256 % 31 != 0, so `byte % 31` would over-produce the first few characters. The generator
       rejection-samples instead. Feed it bytes that are ONLY in the discarded range and it must
       not emit anything from them. */
    const limit = Math.floor(256 / JOIN_CODE_ALPHABET.length) * JOIN_CODE_ALPHABET.length
    expect(255).toBeGreaterThanOrEqual(limit) // 255 is in the discarded tail, so it must be rejected
    let call = 0
    const bytes = (n: number) => {
      call++
      // First call: every byte is out of range and must be discarded. Then valid bytes.
      return new Uint8Array(n).fill(call === 1 ? 255 : 0)
    }
    expect(generateJoinCode(bytes)).toBe(JOIN_CODE_ALPHABET[0].repeat(JOIN_CODE_LENGTH))
    expect(call).toBeGreaterThan(1) // proves the out-of-range bytes were actually rejected
  })

  it('forgives case and stray spaces, and nothing else', () => {
    expect(normalizeJoinCode(' 7k4m ')).toBe('7K4M')
    expect(normalizeJoinCode('7 K 4 M')).toBe('7K4M')
    // A wrong character is a wrong code; stripping it would let a near-miss through.
    expect(isWellFormedJoinCode('7K4O')).toBe(false)
    expect(isWellFormedJoinCode('7K4')).toBe(false)
    expect(isWellFormedJoinCode('7K4MM')).toBe(false)
    expect(isWellFormedJoinCode('7k4m')).toBe(true)
  })
})

// ── the gate ──────────────────────────────────────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockAdminClient() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const ROOM = '11111111-1111-4111-8111-111111111111'
const ME = 'stu-1'

/* eslint-disable @typescript-eslint/no-explicit-any */
let markAttendance: any
let rpcSpy: any
let upsertSpy: any
/* eslint-enable @typescript-eslint/no-explicit-any */

function db(opts: {
  joinCode?: string | null
  alreadyPresent?: boolean
  rateAccepted?: boolean
  setupCompleted?: boolean
  limitErrored?: boolean
}) {
  rpcSpy = vi.fn(async (fn: string) => {
    if (fn !== 'increment_auth_rate_limit') return { data: null }
    if (opts.limitErrored) return { data: null, error: { message: 'limiter unreachable' } }
    return { data: [{ accepted: opts.rateAccepted !== false, resets_at: null }] }
  })
  upsertSpy = vi.fn(async () => ({ error: null }))
  return {
    rpc: rpcSpy,
    from: (table: string) => {
      if (table === 'lc_rooms') {
        return { select: () => ({ eq: () => ({ single: async () => ({
          data: {
            id: ROOM, section_id: 'sec-1', prof_id: 'prof', status: 'live',
            setup_completed: opts.setupCompleted !== false,
          },
          error: null,
        }) }) }) }
      }
      if (table === 'lc_room_codes') {
        const code = opts.joinCode === undefined ? '7K4M' : opts.joinCode
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: code === null ? null : { code },
          error: null,
        }) }) }) }
      }
      if (table === 'enrollments') {
        return { select: () => ({ eq: () => ({ eq: () => ({ in: () => ({
          maybeSingle: async () => ({ data: { id: 'e1' } }),
          single: async () => ({ data: { id: 'e1' } }),
        }) }) }) }) }
      }
      // lc_attendance
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: opts.alreadyPresent ? { student_id: ME } : null,
        }) }) }) }),
        upsert: upsertSpy,
      }
    },
  }
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
  const mod = await import('@/lib/live-classroom/attendance/actions')
  markAttendance = mod.markAttendance
})

describe('markAttendance: the code gate', () => {
  it('asks for a code on a first heartbeat, and records nothing', async () => {
    mockAdminClient.mockReturnValue(db({}))
    const r = await markAttendance(ROOM)
    expect(r.error).toBe('NEEDS_CODE')
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('marks the student present when the code is right', async () => {
    mockAdminClient.mockReturnValue(db({}))
    const r = await markAttendance(ROOM, '7k4m') // lower case on purpose
    expect(r.success).toBe(true)
    expect(upsertSpy).toHaveBeenCalled()
  })

  it('refuses a wrong code without recording attendance', async () => {
    mockAdminClient.mockReturnValue(db({}))
    const r = await markAttendance(ROOM, '7K4N')
    expect(r.error).toMatch(/isn't right/i)
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('never re-asks a student who is already present', async () => {
    /* A browser crash 20 minutes into class must not cost them the prompt again — and the
       3-minute heartbeat would otherwise fail forever, since it carries no code. */
    mockAdminClient.mockReturnValue(db({ alreadyPresent: true }))
    const r = await markAttendance(ROOM)
    expect(r.success).toBe(true)
    expect(upsertSpy).toHaveBeenCalled()
    expect(rpcSpy).not.toHaveBeenCalled() // not even rate-limited
  })

  it('counts an attempt BEFORE comparing, so guessing is bounded', async () => {
    mockAdminClient.mockReturnValue(db({}))
    await markAttendance(ROOM, 'ZZZZ')
    expect(rpcSpy).toHaveBeenCalledWith(
      'increment_auth_rate_limit',
      expect.objectContaining({ p_key: `lc_join:${ROOM}:${ME}` }),
    )
  })

  it('refuses the attempt when the limiter itself is unreachable', async () => {
    /* FAIL CLOSED. If the limiter errors, `data` comes back null — and a check written as
       `accepted !== false` reads that null as "allowed" and silently removes the only thing
       standing between a 4-character code and a script. The login path (claimAuthAttempt)
       refuses on error and this has to match it. */
    mockAdminClient.mockReturnValue(db({ limitErrored: true }))
    const r = await markAttendance(ROOM, '7K4M') // the RIGHT code — still refused
    expect(r.success).toBeUndefined()
    expect(r.error).toMatch(/try again/i)
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('stops accepting attempts once the limit is spent', async () => {
    mockAdminClient.mockReturnValue(db({ rateAccepted: false }))
    const r = await markAttendance(ROOM, '7K4M') // the RIGHT code, but out of attempts
    expect(r.error).toMatch(/too many attempts/i)
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('clears the bucket on success, not on a miss', async () => {
    mockAdminClient.mockReturnValue(db({}))
    await markAttendance(ROOM, '7K4N') // wrong
    expect(rpcSpy.mock.calls.some((c: unknown[]) => c[0] === 'clear_auth_rate_limit')).toBe(false)

    mockAdminClient.mockReturnValue(db({}))
    await markAttendance(ROOM, '7K4M') // right
    expect(rpcSpy.mock.calls.some((c: unknown[]) => c[0] === 'clear_auth_rate_limit')).toBe(true)
  })

  it('records nothing while a start-now room is live but not yet started', async () => {
    /* A "start now" room is INSERTed already live and the section hub advertises it as
       joinable, minutes before the professor finishes uploading a deck and presses Start.
       The code is minted at Start. Without this guard a student at home could join during
       that window and be ticked present having never seen the projector — the whole thing
       the code exists to prevent, through the front door. */
    mockAdminClient.mockReturnValue(db({ setupCompleted: false, joinCode: null }))
    const r = await markAttendance(ROOM)
    expect(r.error).toMatch(/not started/i)
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('keeps working for a session that started before this feature', async () => {
    /* Classes already running at deploy time have no code row. Demanding one would strand
       them halfway through a lecture. */
    mockAdminClient.mockReturnValue(db({ joinCode: null }))
    const r = await markAttendance(ROOM)
    expect(r.success).toBe(true)
    expect(upsertSpy).toHaveBeenCalled()
  })
})

// ── the code must never reach a student ───────────────────────────────────

describe('the code is not readable by the people it gates', () => {
  /* The first cut of this feature put join_code on lc_rooms, where the policy "students view
     rooms in enrolled sections" let any enrolled student SELECT it straight from the browser
     — the code was readable by exactly the people it exists to stop. It now lives on
     lc_room_codes, which students have no policy for. These read the source, so putting it
     back on a student-reachable read fails here by name. */
  const read = (f: string) =>
    readFileSync(join(process.cwd(), 'src', f), 'utf8')

  it('does not store the code anywhere a student can select it', () => {
    const queries = read('lib/supabase/queries.ts')
    /* The exact column list every getRoomById caller receives — and the student room page is
       one of those callers. */
    const cols = queries.match(/const LC_ROOM_COLUMNS\s*=\s*'([^']+)'/)
    expect(cols).not.toBeNull()
    expect(cols![1]).not.toContain('code')

    // getRoomJoinCode reads the professor-only table, not the room row.
    const fn = queries.slice(queries.indexOf('async getRoomJoinCode'))
    const body = fn.slice(0, fn.indexOf('\n  },'))
    expect(body).toContain("from('lc_room_codes')")
    expect(body).not.toContain("from('lc_rooms')")
  })

  it('keeps the database CHECK and the generator on the same alphabet', () => {
    /* The table constrains the code's shape, so a generator that drifted from it would not
       produce a bad code — it would make every class START fail, on a constraint nobody is
       looking at during a lecture. Read both and compare. */
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260829120000_lc_attendance_join_code.sql'),
      'utf8',
    )
    const check = sql.match(/CHECK \(code ~ '\^\[([^\]]+)\]\{(\d+)\}\$'\)/)
    expect(check).not.toBeNull()
    expect(check![1]).toBe(JOIN_CODE_ALPHABET)
    expect(Number(check![2])).toBe(JOIN_CODE_LENGTH)
  })

  it('never sends the code to the student room page', () => {
    /* The student view gets its room through getRoomSnapshot. If the code ever appears in
       what that returns, the browser has it and the projector is decorative. */
    const snapshot = read('lib/live-classroom/snapshot.ts')
    expect(snapshot).not.toContain('lc_room_codes')
    expect(snapshot).not.toContain('join_code')
  })
})
