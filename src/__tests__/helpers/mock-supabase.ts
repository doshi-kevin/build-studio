// Centralized Supabase mock factories for server action tests.
// Extracted from security-auth-checks.test.ts and generalized for reuse.

import { vi } from 'vitest'

// ── Chain Result Type ─────────────────────────────────────────

export interface ChainResult {
  data: unknown
  error: unknown
  count?: number
}

// ── Basic Chain Builder ───────────────────────────────────────
// Supports: .from().select().eq().in().single()

export function buildChain(finalResult: ChainResult) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.not = vi.fn().mockReturnValue(chain)
  chain.or = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.gte = vi.fn().mockReturnValue(chain)
  chain.lt = vi.fn().mockReturnValue(chain)
  chain.lte = vi.fn().mockReturnValue(chain)
  chain.like = vi.fn().mockReturnValue(chain)
  chain.ilike = vi.fn().mockReturnValue(chain)
  chain.contains = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.range = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.then = undefined
  return chain
}

// ── Full Chain Builder ────────────────────────────────────────
// Also supports: .insert(), .update(), .delete(), .upsert(), and thenable

export function buildFullChain(finalResult: ChainResult) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {}

  // Query methods
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.not = vi.fn().mockReturnValue(chain)
  chain.or = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.gte = vi.fn().mockReturnValue(chain)
  chain.lt = vi.fn().mockReturnValue(chain)
  chain.lte = vi.fn().mockReturnValue(chain)
  chain.like = vi.fn().mockReturnValue(chain)
  chain.ilike = vi.fn().mockReturnValue(chain)
  chain.contains = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.range = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)

  // Mutation methods
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.upsert = vi.fn().mockReturnValue(chain)

  // Make the chain thenable (for queries without .single())
  const thenable = Object.assign(chain, {
    then: (res: (v: unknown) => void) => Promise.resolve(finalResult).then(res),
  })

  return thenable
}

// ── Admin Client Factory ──────────────────────────────────────
// Creates a mock admin client with table call tracking.

export function createMockAdminClient(
  overrides: Record<string, ChainResult> = {},
) {
  const tableCalls: string[] = []

  const client = {
    from: vi.fn((table: string) => {
      tableCalls.push(table)
      const result = overrides[table] ?? { data: [], error: null }
      return buildChain(result)
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    auth: {
      admin: {
        createUser: vi.fn().mockResolvedValue({ data: { user: { id: 'new-user-id' } }, error: null }),
        deleteUser: vi.fn().mockResolvedValue({ data: null, error: null }),
        inviteUserByEmail: vi.fn().mockResolvedValue({ data: { user: { id: 'invited-user-id' } }, error: null }),
      },
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'test-path' }, error: null }),
        remove: vi.fn().mockResolvedValue({ data: null, error: null }),
        getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://test.supabase.co/test' } }),
      }),
    },
    /** Access the tracked table calls for assertions */
    _tableCalls: tableCalls,
  }

  return client
}

// ── Table Router ──────────────────────────────────────────────
// For complex tests needing per-table chain configuration.

export function createTableRouter(
  chains: Record<string, ReturnType<typeof buildFullChain>>,
) {
  return {
    from: vi.fn((table: string) =>
      chains[table] ?? buildFullChain({ data: null, error: null }),
    ),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }
}
