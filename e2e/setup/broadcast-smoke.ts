/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase 0 integration smoke test for the Live Classroom broadcast
// architecture. This is the gate that proves the trigger + RLS plumbing
// from migration 34 actually works end-to-end before Phase 1 swaps any
// UI consumer onto it.
//
// What it does, against the local Supabase stack:
//   1. Creates a temporary lc_rooms row owned by the seeded e2e
//      professor and a fresh test student enrolled in the same section.
//   2. Subscribes to the room's authoritative private topic
//      (`room:<uuid>`) as the student.
//   3. Triggers an UPDATE on lc_rooms.current_slide via the admin client.
//   4. Asserts the broadcast event arrives within 2s with the correct
//      payload shape, type='slide_changed', and seq != null.
//   5. Calls getEventsSince via a direct admin query and asserts the
//      same event is in the replay buffer.
//   6. Subscribes a second student client and attempts to send a spoof
//      `slide_changed` event on the authoritative topic via channel.send().
//      Asserts the spoof is NOT received by the first subscriber (RLS
//      INSERT denial).
//   7. Cleans up: deletes the lc_events rows and the lc_rooms row.
//
// Run with:  npx tsx e2e/setup/broadcast-smoke.ts
// Requires:  - Local Supabase running (`supabase start`).
//            - .env.test loaded into the shell (or sourced manually).
//            - npm run db:seed:e2e has run at least once so seed-ids.json
//              and the e2e users exist.

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

loadEnv({ path: path.resolve(__dirname, '..', '..', '.env.test') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error('[broadcast-smoke] Missing env. Source .env.test first.')
  process.exit(1)
}
if (!SUPABASE_URL.startsWith('http://127.0.0.1') && !SUPABASE_URL.startsWith('http://localhost')) {
  console.error(`[broadcast-smoke] Refusing to run against non-local URL: ${SUPABASE_URL}`)
  process.exit(1)
}

const SHARED_PASSWORD = 'e2e-password-123'

interface SeedIds {
  users: Record<string, string>
  section: string
}
function loadSeedIds(): SeedIds {
  const p = path.resolve(__dirname, '..', 'fixtures', 'seed-ids.json')
  if (!fs.existsSync(p)) {
    throw new Error(`seed-ids.json not found at ${p} — run 'npm run db:seed:e2e' first.`)
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as SeedIds
}

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function asUser(email: string): Promise<SupabaseClient> {
  const client = createSupabaseClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: SHARED_PASSWORD,
  })
  if (error || !data.session) {
    throw new Error(`signIn failed for ${email}: ${error?.message}`)
  }
  // Push the JWT into the realtime client so private channels authorize.
  client.realtime.setAuth(data.session.access_token)
  return client
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(
  predicate: () => T | null | undefined,
  timeoutMs = 2000,
  intervalMs = 50,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = predicate()
    if (value != null) return value
    await delay(intervalMs)
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

async function main() {
  const seed = loadSeedIds()
  const profId = seed.users.professor
  const studentId = seed.users.studentEnrolled
  const sectionId = seed.section
  if (!profId || !studentId || !sectionId) {
    throw new Error('seed-ids.json missing professor / studentEnrolled / section')
  }

  console.log('[broadcast-smoke] Creating test room…')
  const { data: room, error: roomErr } = await admin
    .from('lc_rooms')
    .insert({
      section_id: sectionId,
      prof_id: profId,
      status: 'live',
      current_slide: 0,
    })
    .select('id')
    .single()
  if (roomErr || !room) throw new Error(`create room: ${roomErr?.message}`)
  const roomId = (room as { id: string }).id
  console.log(`[broadcast-smoke]   roomId=${roomId}`)

  let testFailed = false

  try {
    // ── Step 1: subscribe as student, listen for slide_changed ─────
    console.log('[broadcast-smoke] Subscribing as student to room:<id>…')
    const student = await asUser('e2e-student-enrolled@scholera.test')
    const received: Array<{ seq: number | null; data: { slideIndex: number } }> = []
    const channel = student.channel(`room:${roomId}`, { config: { private: true } })
    channel.on('broadcast', { event: 'slide_changed' }, (msg: { payload: any }) => {
      received.push({ seq: msg.payload?.seq, data: msg.payload?.data })
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('subscribe timeout')), 5000)
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout)
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timeout)
          reject(new Error(`subscribe got ${status}`))
        }
      })
    })
    console.log('[broadcast-smoke]   subscribed')

    // ── Step 2: trigger slide change via admin update ──────────────
    console.log('[broadcast-smoke] Updating lc_rooms.current_slide=3…')
    const { error: updateErr } = await admin
      .from('lc_rooms')
      .update({ current_slide: 3 })
      .eq('id', roomId)
    if (updateErr) throw new Error(`update slide: ${updateErr.message}`)

    // ── Step 3: wait for the broadcast ─────────────────────────────
    const event = await waitFor(() => received[0], 2000)
    if (event.seq == null) throw new Error('expected non-null seq on authoritative event')
    if (event.data.slideIndex !== 3) throw new Error(`expected slideIndex=3, got ${event.data.slideIndex}`)
    console.log(`[broadcast-smoke]   ✓ received slide_changed seq=${event.seq} slideIndex=3`)

    // ── Step 4: replay buffer contains the same event ──────────────
    console.log('[broadcast-smoke] Verifying replay buffer…')
    const { data: events, error: eventsErr } = await admin
      .from('lc_events')
      .select('seq, event_type, payload')
      .eq('room_id', roomId)
      .order('seq', { ascending: true })
    if (eventsErr) throw new Error(`replay query: ${eventsErr.message}`)
    if (!events?.length) throw new Error('replay buffer empty')
    const slideEvent = events.find((e: any) => e.event_type === 'slide_changed')
    if (!slideEvent) throw new Error('no slide_changed in replay buffer')
    console.log(`[broadcast-smoke]   ✓ replay buffer has ${events.length} event(s)`)

    // ── Step 5: spoof rejection ────────────────────────────────────
    console.log('[broadcast-smoke] Attempting spoofed slide_changed from client…')
    const spoofClient = await asUser('e2e-student-enrolled@scholera.test')
    const spoofChannel = spoofClient.channel(`room:${roomId}`, { config: { private: true } })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('spoof channel sub timeout')), 5000)
      spoofChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout)
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timeout)
          reject(new Error(`spoof channel got ${status}`))
        }
      })
    })
    const beforeCount = received.length
    const sendResult = await spoofChannel.send({
      type: 'broadcast',
      event: 'slide_changed',
      payload: { seq: 999, ts: 't', type: 'slide_changed', data: { slideIndex: 99 } },
    })
    // Either the send returns an error status, or it succeeds at the
    // client layer but RLS drops the message before fanout. Both are
    // acceptable; what matters is that the original subscriber does NOT
    // receive a spoof event.
    console.log(`[broadcast-smoke]   send result: ${sendResult}`)
    await delay(800)
    const newSpoofCount = received.length - beforeCount
    if (newSpoofCount > 0) {
      throw new Error(`SECURITY FAILURE: spoofed event was delivered (${newSpoofCount} extra events)`)
    }
    console.log('[broadcast-smoke]   ✓ spoofed event was rejected')

    await spoofClient.removeChannel(spoofChannel)
    await student.removeChannel(channel)

    console.log('[broadcast-smoke] ALL CHECKS PASSED ✓')
  } catch (err) {
    testFailed = true
    console.error('[broadcast-smoke] FAILED:', err)
  } finally {
    // ── Cleanup ────────────────────────────────────────────────────
    console.log('[broadcast-smoke] Cleaning up…')
    await admin.from('lc_events').delete().eq('room_id', roomId)
    await admin.from('lc_rooms').delete().eq('id', roomId)
  }

  process.exit(testFailed ? 1 : 0)
}

main().catch((err) => {
  console.error('[broadcast-smoke] UNHANDLED:', err)
  process.exit(1)
})
