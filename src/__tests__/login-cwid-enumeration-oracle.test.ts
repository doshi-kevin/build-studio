// Pins the three auth fixes in src/app/(auth)/login/actions.ts.
//
// All three are silent-failure shaped: nothing crashes if they regress, the login page
// keeps working, and the leak is only visible to someone probing the endpoint.
//
// 1. resolveCwidToEmail — this action is exported from a PUBLIC page, so it is callable
//    with no session. Resolving an 8-digit CWID to an email on the CWID alone made it an
//    unauthenticated PII-harvest oracle over a sequential, fully walkable id space, with
//    the admin client bypassing RLS. It now requires the account password, and — the part
//    these tests exist for — "no such CWID" and "wrong password" must be INDISTINGUISHABLE.
//    An asymmetry in the return value re-opens the oracle even with the password gate on,
//    because the attacker just supplies a junk password and reads which error came back.
//
// 2. sendPasswordResetForIdentifier — the reset flow has no password to gate on, so it
//    resolves the CWID server-side and must NEVER return the address (or any signal that
//    the identifier matched).
//
// 3. handleInviteAcceptance — used to take a userId, making it a publicly callable write
//    on any pending profile in any institution. It must derive the caller from the session.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockResetPasswordForEmail = vi.fn()
const mockAdminClient = vi.fn()
const mockCreateSupabaseClient = vi.fn()
const mockSignInWithPassword = vi.fn()
const mockSignOut = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
      resetPasswordForEmail: mockResetPasswordForEmail,
    },
  })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
// The credential check builds its own throwaway client straight from supabase-js.
vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateSupabaseClient(...args),
}))

/**
 * Admin double. `profileRow` is what `.from('profiles').select().eq().single()`
 * (or `.maybeSingle()` — the CWID lookup uses the latter so a duplicate CWID across
 * two institutions surfaces as ambiguity rather than a thrown error) resolves
 * to; `updates` records every `.update(...).eq(...)` so a write to the wrong id is visible.
 */
function makeAdmin(
  profileRow: { data: unknown; error: unknown },
  /**
   * Pre-auth limiter double. Both actions now claim an attempt through
   * increment_auth_rate_limit before doing any work, and clear it on success. The
   * limiter FAILS CLOSED, so a double that omits `.rpc` makes every action return its
   * rejection shape — set `limiterAccepts: false` to exercise that on purpose.
   */
  limiterAccepts = true,
) {
  const updates: { payload: unknown; column: string; value: unknown }[] = []
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = []
  /** Every table touched, so a test can assert `profiles` was never queried. */
  const tables: string[] = []
  const client = {
    from: (table: string) => (tables.push(table), {
      select: () => ({ eq: () => ({ single: async () => profileRow, maybeSingle: async () => profileRow }) }),
      update: (payload: unknown) => ({
        eq: async (column: string, value: unknown) => {
          updates.push({ payload, column, value })
          return { error: null }
        },
      }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (fn === 'increment_auth_rate_limit') {
        return { data: [{ accepted: limiterAccepts, resets_at: null }], error: null }
      }
      return { data: null, error: null }
    },
  }
  return { client, updates, rpcCalls, tables }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: null }, error: null })
  mockResetPasswordForEmail.mockReset().mockResolvedValue({ error: null })
  mockAdminClient.mockReset()
  mockSignInWithPassword.mockReset().mockResolvedValue({ data: {}, error: null })
  mockSignOut.mockReset().mockResolvedValue({ error: null })
  mockCreateSupabaseClient
    .mockReset()
    // signOut is part of the contract: the action discards the verifier's session so
    // a successful CWID login does not leave an orphaned refresh token behind.
    .mockReturnValue({ auth: { signInWithPassword: mockSignInWithPassword, signOut: mockSignOut } })
  mod = await import('@/app/(auth)/login/actions')
})

// ── resolveCwidToEmail ────────────────────────────────────────────────────────

describe('resolveCwidToEmail — the enumeration oracle must stay closed', () => {
  const GOOD_ROW = { data: { email: 'student@scholera.dev' }, error: null }
  const NO_ROW = { data: null, error: { code: 'PGRST116', message: 'no rows' } }

  it('resolves the email only when the CWID AND the password are both right', async () => {
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    const res = await mod.resolveCwidToEmail('12345678', 'correct-horse')
    expect(res).toEqual({ email: 'student@scholera.dev' })
  })

  it('returns the SAME null result for an unknown CWID and for a wrong password', async () => {
    // Unknown CWID: the profiles lookup finds nothing.
    mockAdminClient.mockReturnValue(makeAdmin(NO_ROW).client)
    const unknownCwid = await mod.resolveCwidToEmail('99999999', 'anything')

    // Known CWID, wrong password: the credential check rejects.
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    mockSignInWithPassword.mockResolvedValue({
      data: null,
      error: { message: 'Invalid login credentials', status: 400 },
    })
    const wrongPassword = await mod.resolveCwidToEmail('12345678', 'wrong')

    // Deep-equal, not just "both falsy": any extra discriminating field (a code, a
    // reason, a differing shape) is the oracle coming back.
    expect(unknownCwid).toEqual({ email: null })
    expect(wrongPassword).toEqual({ email: null })
    expect(unknownCwid).toEqual(wrongPassword)
    expect(Object.keys(unknownCwid)).toEqual(Object.keys(wrongPassword))
  })

  it('never leaks the address when the password is wrong', async () => {
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    mockSignInWithPassword.mockResolvedValue({
      data: null,
      error: { message: 'Invalid login credentials' },
    })
    const res = await mod.resolveCwidToEmail('12345678', 'wrong')
    expect(JSON.stringify(res)).not.toContain('student@scholera.dev')
  })

  it('refuses to look anything up at all when no password is supplied', async () => {
    const { client } = makeAdmin(GOOD_ROW)
    mockAdminClient.mockReturnValue(client)

    expect(await mod.resolveCwidToEmail('12345678', '')).toEqual({ email: null })
    // The bare-CWID probe must not even reach the admin client — that lookup IS the leak.
    expect(mockAdminClient).not.toHaveBeenCalled()
    expect(mockSignInWithPassword).not.toHaveBeenCalled()
  })

  it('refuses when the pre-auth limiter is at cap, indistinguishably from a bad password', async () => {
    // The limiter is the only thing bounding brute force here: verifying server-side
    // moves the GoTrue call onto the app's egress IP, out from behind GoTrue's own
    // per-IP throttle. Being throttled must look exactly like a wrong password, or the
    // block itself becomes the oracle ("this CWID is worth attacking").
    const { client } = makeAdmin(GOOD_ROW, /* limiterAccepts */ false)
    mockAdminClient.mockReturnValue(client)

    const throttled = await mod.resolveCwidToEmail('12345678', 'correct-horse')

    expect(throttled).toEqual({ email: null })
    // And it must cost us nothing: no password verification once at cap.
    expect(mockSignInWithPassword).not.toHaveBeenCalled()
  })

  it('claims BOTH the cwid and ip buckets, and clears them on success', async () => {
    // Two buckets because either alone leaves a hole: the cwid bucket bounds
    // brute-forcing one account, the ip bucket bounds walking the id space.
    const { client, rpcCalls } = makeAdmin(GOOD_ROW)
    mockAdminClient.mockReturnValue(client)

    await mod.resolveCwidToEmail('12345678', 'correct-horse')

    const claims = rpcCalls.filter((c) => c.fn === 'increment_auth_rate_limit')
    expect(claims).toHaveLength(2)
    expect(claims.map((c) => c.args.p_key)).toEqual(['cwid:12345678', 'ip:unknown'])

    // Cleared on success, so only FAILURES accumulate — otherwise an ordinary heavy
    // user would eventually throttle themselves.
    const clears = rpcCalls.filter((c) => c.fn === 'clear_auth_rate_limit')
    expect(clears.map((c) => c.args.p_key)).toEqual(['cwid:12345678', 'ip:unknown'])
  })

  it('does NOT clear the buckets when the password was wrong', async () => {
    const { client, rpcCalls } = makeAdmin(GOOD_ROW)
    mockAdminClient.mockReturnValue(client)
    mockSignInWithPassword.mockResolvedValue({
      data: null,
      error: { message: 'Invalid login credentials' },
    })

    await mod.resolveCwidToEmail('12345678', 'wrong')

    // A failure must leave the counter standing, or the cap can never be reached.
    expect(rpcCalls.filter((c) => c.fn === 'clear_auth_rate_limit')).toHaveLength(0)
  })

  it('returns null for an empty CWID without probing', async () => {
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    expect(await mod.resolveCwidToEmail('', 'some-password')).toEqual({ email: null })
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('still pays the verification cost when the row carries no email', async () => {
    mockAdminClient.mockReturnValue(makeAdmin({ data: { email: null }, error: null }).client)
    expect(await mod.resolveCwidToEmail('12345678', 'pw')).toEqual({ email: null })
    // Deliberately the OPPOSITE of "must not be called": skipping the verifier on a
    // miss is what made CWID validity observable by timing, since only a hit paid for
    // a password hash. The work must match on both paths, so the call must happen —
    // against an unroutable sentinel that can never be a real account.
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(1)
    expect(mockSignInWithPassword.mock.calls[0][0].email).toMatch(
      /^cwid-miss-[0-9a-f-]{36}@invalid\.scholera\.internal$/,
    )
  })

  it('checks the password against the resolved email, not the raw CWID', async () => {
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    await mod.resolveCwidToEmail('12345678', 'correct-horse')
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: 'student@scholera.dev',
      password: 'correct-horse',
    })
  })

  it('verifies with the ANON key and establishes no session', async () => {
    // Deliberate design choice documented in the action: the check must use the same
    // public key and call the browser is about to make, and must not persist a session.
    // Swapping in the service-role client would change what a "successful" password
    // grant even means on the login path.
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    await mod.resolveCwidToEmail('12345678', 'correct-horse')

    const [url, key, options] = mockCreateSupabaseClient.mock.calls[0]
    expect(url).toBe(process.env.NEXT_PUBLIC_SUPABASE_URL)
    expect(key).toBe(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    expect(key).not.toBe(process.env.SUPABASE_SERVICE_ROLE_KEY)
    expect(options.auth.persistSession).toBe(false)
  })

  it('returns null rather than throwing when the credential check blows up', async () => {
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    mockSignInWithPassword.mockRejectedValue(new Error('network down'))
    expect(await mod.resolveCwidToEmail('12345678', 'pw')).toEqual({ email: null })
  })
})

// ── sendPasswordResetForIdentifier ───────────────────────────────────────────

describe('sendPasswordResetForIdentifier — resolves server-side, tells the caller nothing', () => {
  const GOOD_ROW = { data: { email: 'student@scholera.dev' }, error: null }

  it('returns success and NOTHING else for a CWID that resolves', async () => {
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    const res = await mod.sendPasswordResetForIdentifier('12345678')

    expect(res).toEqual({ success: true })
    // The whole point: the resolved address must not ride back to the browser in any
    // field, however incidental.
    expect(Object.keys(res)).toEqual(['success'])
    expect(JSON.stringify(res)).not.toContain('student@scholera.dev')
  })

  it('sends the reset to the address the CWID resolved to', async () => {
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    await mod.sendPasswordResetForIdentifier('12345678')
    expect(mockResetPasswordForEmail).toHaveBeenCalledWith(
      'student@scholera.dev',
      expect.objectContaining({ redirectTo: expect.stringContaining('/auth/callback') }),
    )
  })

  it('is indistinguishable for a CWID that matches nothing', async () => {
    mockAdminClient.mockReturnValue(
      makeAdmin({ data: null, error: { code: 'PGRST116' } }).client,
    )
    const res = await mod.sendPasswordResetForIdentifier('99999999')

    expect(res).toEqual({ success: true })
    // The caller cannot tell — that is the whole contract. The reset call still runs,
    // against an unroutable sentinel, so an unknown CWID costs the same as a known one
    // and no mail is generated. Asserting it is NOT called would re-encode the timing
    // oracle this test exists to prevent.
    expect(mockResetPasswordForEmail).toHaveBeenCalledTimes(1)
    expect(mockResetPasswordForEmail.mock.calls[0][0]).toMatch(
      /^cwid-miss-[0-9a-f-]{36}@invalid\.scholera\.internal$/,
    )
  })

  it('treats a non-CWID identifier as an email and never touches profiles', async () => {
    const { client, tables } = makeAdmin(GOOD_ROW)
    mockAdminClient.mockReturnValue(client)

    const res = await mod.sendPasswordResetForIdentifier('  prof@scholera.dev  ')

    expect(res).toEqual({ success: true })
    // The admin client IS constructed now (the pre-auth limiter runs through it), so
    // assert the invariant directly instead of inferring it from construction: an
    // email identifier must never trigger a CWID lookup against profiles.
    expect(tables).not.toContain('profiles')
    expect(mockResetPasswordForEmail).toHaveBeenCalledWith(
      'prof@scholera.dev',
      expect.anything(),
    )
  })

  /* DO NOT "improve" these two by reporting the send failure to the caller. It is a tempting
     fix — a real Supabase 500 (2026-08-11) meant no email was ever created while the page
     still said "we've sent a reset link", and users waited on nothing. But surfacing it
     reopens the oracle this file exists to close:

       known CWID   -> real address -> SMTP attempted -> fails during an outage -> "failed"
       unknown CWID -> sentinel     -> always fails                            -> also fails

     ...except Supabase never errors for an address it doesn't recognise, so in practice
     "failed" would mean "this identifier is real" and silence would mean "it isn't" — a
     working enumeration oracle over the 8-digit CWID space, available to anyone, for as long
     as mail is down. The failure is surfaced via logger.error and honest page copy instead. */
  it('still reports success when Supabase rejects the send', async () => {
    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    mockResetPasswordForEmail.mockResolvedValue({ error: { message: 'rate limited' } })
    expect(await mod.sendPasswordResetForIdentifier('12345678')).toEqual({ success: true })
  })

  it('reports the SAME shape whether the send fails for a real address or the sentinel', async () => {
    const failure = { error: { name: 'AuthRetryableFetchError', status: 500, message: '{}' } }

    mockAdminClient.mockReturnValue(makeAdmin(GOOD_ROW).client)
    mockResetPasswordForEmail.mockResolvedValue(failure)
    const knownCwid = await mod.sendPasswordResetForIdentifier('12345678')

    mockAdminClient.mockReturnValue(makeAdmin({ data: null, error: { code: 'PGRST116' } }).client)
    mockResetPasswordForEmail.mockResolvedValue(failure)
    const unknownCwid = await mod.sendPasswordResetForIdentifier('99999999')

    // Byte-identical, or mail-outage-time enumeration is back.
    expect(knownCwid).toEqual(unknownCwid)
    expect(knownCwid).toEqual({ success: true })
  })

  it('still reports success when the lookup throws', async () => {
    mockAdminClient.mockImplementation(() => {
      throw new Error('admin client unavailable')
    })
    expect(await mod.sendPasswordResetForIdentifier('12345678')).toEqual({ success: true })
  })

  it('only treats an exactly-8-digit identifier as a CWID', async () => {
    const { client, tables } = makeAdmin(GOOD_ROW)
    mockAdminClient.mockReturnValue(client)
    await mod.sendPasswordResetForIdentifier('1234567')
    expect(tables).not.toContain('profiles')

    await mod.sendPasswordResetForIdentifier('123456789')
    expect(tables).not.toContain('profiles')
  })
})

// ── handleInviteAcceptance ───────────────────────────────────────────────────

describe('handleInviteAcceptance — the caller comes from the session, never an argument', () => {
  it('stamps the SESSION user, ignoring any id an attacker passes', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'session-user' } }, error: null })
    const { client, updates } = makeAdmin({ data: { invite_status: 'pending' }, error: null })
    mockAdminClient.mockReturnValue(client)

    // The old signature took a userId. A caller that still passes one — or an attacker
    // replaying the request with a victim's profile id read off a roster surface — must
    // have no effect on which row is written.
    await mod.handleInviteAcceptance('victim-user-id')

    expect(updates).toHaveLength(1)
    expect(updates[0].column).toBe('id')
    expect(updates[0].value).toBe('session-user')
    expect(updates[0].value).not.toBe('victim-user-id')
  })

  it('writes nothing at all when there is no session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const { client, updates } = makeAdmin({ data: { invite_status: 'pending' }, error: null })
    mockAdminClient.mockReturnValue(client)

    await mod.handleInviteAcceptance('victim-user-id')

    expect(updates).toHaveLength(0)
    // Unauthenticated calls must not reach the RLS-bypassing client.
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('writes nothing when getUser reports an auth error', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } })
    const { client, updates } = makeAdmin({ data: { invite_status: 'pending' }, error: null })
    mockAdminClient.mockReturnValue(client)

    await mod.handleInviteAcceptance()

    expect(updates).toHaveLength(0)
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('leaves an already-accepted invite alone', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'session-user' } }, error: null })
    const { client, updates } = makeAdmin({ data: { invite_status: 'accepted' }, error: null })
    mockAdminClient.mockReturnValue(client)

    await mod.handleInviteAcceptance()

    expect(updates).toHaveLength(0)
  })
})
