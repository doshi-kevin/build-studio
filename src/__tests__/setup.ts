// Vitest global setup — extends expect with DOM matchers and loads env.
import '@testing-library/jest-dom/vitest'
import { config as loadEnv } from 'dotenv'
import path from 'path'
import { vi } from 'vitest'

// Load .env.test so modules that read process.env at import time (e.g. the
// Supabase-origin allowlist in invite-redirects.ts) see the same values the
// app sees at runtime.
loadEnv({ path: path.resolve(__dirname, '../../.env.test') })

// Force a deterministic, hermetic test env. We assign (not ??=) on purpose:
// CI sets NEXT_PUBLIC_SUPABASE_URL to a build-time placeholder at the job
// level, which must NOT leak into tests — the invite-redirects origin
// allowlist (read at import time) requires the local Supabase CLI origin its
// fixtures are built against. Forcing also keeps tests off any real project
// and lets createAdminClient construct without real secrets. setupFiles run
// before test modules import, so these are set before any import-time read.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'

// jsdom has no ResizeObserver; Radix measures with it (Tooltip, Select, …).
// A no-op stub keeps components rendering — tests never assert on sizes.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as typeof ResizeObserver)

// ── mockChannel ──────────────────────────────────────────────────────
//
// Reusable Supabase RealtimeChannel double for tests that exercise the
// Live Classroom broadcast architecture (use-room-channel and any
// downstream hook). Captures every .on() listener so tests can simulate
// incoming events via channel.simulate(...) and the .subscribe(callback)
// status callback so tests can drive the lifecycle.

type BroadcastCallback = (msg: { event: string; payload: unknown }) => void
type PresenceCallback = (msg: unknown) => void
type SubscribeCallback = (status: string) => void

export interface MockChannel {
  // RealtimeChannel surface used in production code.
  on: (
    eventType: string,
    filter: { event: string } | Record<string, unknown>,
    cb: BroadcastCallback | PresenceCallback,
  ) => MockChannel
  subscribe: (cb?: SubscribeCallback) => MockChannel
  send: (msg: { type: string; event: string; payload: unknown }) => Promise<'ok'>
  unsubscribe: () => Promise<'ok'>
  track: (state: unknown) => Promise<'ok'>
  untrack: () => Promise<'ok'>
  // Test helpers.
  simulate: (event: string, payload: unknown) => void
  simulateStatus: (status: string) => void
  topic: string
  config: Record<string, unknown> | undefined
}

export function mockChannel(
  topic: string,
  config?: Record<string, unknown>,
): MockChannel {
  const broadcastListeners = new Map<string, BroadcastCallback[]>()
  let statusCallback: SubscribeCallback | null = null

  const channel: MockChannel = {
    topic,
    config,
    on(eventType, filter, cb) {
      if (eventType === 'broadcast' && 'event' in filter && typeof filter.event === 'string') {
        const eventName: string = filter.event
        const arr = broadcastListeners.get(eventName) ?? []
        arr.push(cb as BroadcastCallback)
        broadcastListeners.set(eventName, arr)
      }
      // Presence/system listeners are accepted but not asserted on.
      return channel
    },
    subscribe(cb) {
      statusCallback = cb ?? null
      return channel
    },
    send: vi.fn(async (): Promise<'ok'> => 'ok'),
    unsubscribe: vi.fn(async (): Promise<'ok'> => 'ok'),
    track: vi.fn(async (): Promise<'ok'> => 'ok'),
    untrack: vi.fn(async (): Promise<'ok'> => 'ok'),
    simulate(event, payload) {
      const listeners = broadcastListeners.get(event) ?? []
      for (const listener of listeners) {
        listener({ event, payload })
      }
    },
    simulateStatus(status) {
      statusCallback?.(status)
    },
  }

  return channel
}
