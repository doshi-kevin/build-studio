// Resilient room channel hook. This is the centerpiece of the Live
// Classroom broadcast architecture. Every consumer hook (use-slide-sync,
// use-interactions, use-questions, use-drawings, use-presence) subscribes
// to events through the EventBus returned here rather than opening its
// own Supabase channel.
//
// What it handles, in order:
//   1. Subscribe to the room's authoritative + ephemeral private topics.
//   2. Replay any events the client missed since `lastSeq` (passed in from
//      the snapshot fetched by the consumer).
//   3. Dedupe events by `seq` (a Set capped at 500 entries) — covers the
//      snapshot → broadcast → replay duplicate race.
//   4. Drop spoof attempts: any event arriving on the authoritative topic
//      with `seq == null` is rejected (RLS already denies INSERT, this is
//      defense in depth).
//   5. Reconnect with exponential backoff on CHANNEL_ERROR / TIMED_OUT /
//      CLOSED, replaying again from the latest `lastSeq` after each
//      successful re-subscribe.
//   6. On document.visibilitychange→visible, force a re-replay even if
//      the channel still reports SUBSCRIBED — phones background WebSockets
//      silently and the channel can stay "alive" while events are dropped.
//
// The hook does NOT perform the initial snapshot fetch — that is the
// caller's responsibility (one round-trip via getRoomSnapshot). The hook
// receives the resulting `lastSeq` and is responsible for everything from
// that point on.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import { getEventsSince } from '@/lib/live-classroom/replay'
import { EventBus } from './event-bus'
import {
  authoritativeTopic,
  ephemeralTopic,
  AUTHORITATIVE_EVENT_TYPES,
  EPHEMERAL_EVENT_TYPES,
  NULL_SEQ_AUTHORITATIVE_TYPES,
  type LcEvent,
  type LcEventType,
} from './types'
import {
  logChannelStatus,
  logReplay,
  logSpoofRejected,
} from './observability'

export type ConnectionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'replaying'
  | 'closed'

export interface UseRoomChannelOptions {
  /** Room id — drives both topic names. */
  roomId: string
  /** Last seq the client has already applied (from getRoomSnapshot). */
  initialLastSeq: number | null
  /** Maximum number of seqs to retain for dedup (default 500). */
  dedupCap?: number
  /** Called when getEventsSince hits its row cap and the local state may
   *  have a gap. Caller should re-fetch the snapshot. */
  onReplayTruncated?: () => void
  /**
   * Called after the channel RE-subscribes following a drop (never on the first
   * subscribe). The caller should re-fetch its snapshot.
   *
   * Replay alone is not enough to trust after a drop (#639). It reads forward from the
   * last seq this client applied, so anything it never got a chance to apply — an event
   * dispatched while a listener was not yet registered, or one past the replay row cap —
   * is invisible to it, and the dedup set guarantees it is never offered again. A
   * snapshot is absolute rather than relative, so it repairs state the cursor cannot.
   */
  onResync?: () => void
}

export interface UseRoomChannelResult {
  /** Subscribe to typed events here. */
  bus: EventBus
  /** Coarse-grained connection status for UI display ("Reconnecting…"). */
  status: ConnectionStatus
  /** Most recent error message, if any. */
  error: string | null
  /** Most recent applied seq. */
  lastSeq: number | null
  /**
   * The room's SUBSCRIBED ephemeral channel, for callers that need to send on it
   * (reactions, annotation strokes). Null until the subscribe completes.
   *
   * Exposed because the alternative was each sender calling
   * `supabase.channel(ephemeralTopic(roomId))` for itself, on the belief that Supabase
   * dedups by topic. It does not: that yields a SEPARATE channel object which was never
   * subscribed, and sending on an unsubscribed channel is not the same path as sending on
   * a joined one. That is the most likely reason students saw a "Sent" tick for reactions
   * the professor never received (#641).
   */
  ephemeralChannel: RealtimeChannel | null
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000]
/** How long a subscribe must hold before the backoff counter is considered safe to reset. */
const CONNECTION_STABLE_MS = 10_000

export function useRoomChannel({
  roomId,
  initialLastSeq,
  dedupCap = 500,
  onReplayTruncated,
  onResync,
}: UseRoomChannelOptions): UseRoomChannelResult {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [lastSeq, setLastSeq] = useState<number | null>(initialLastSeq)
  /* State, not just the ref below: consumers need to re-render once the channel is joined,
     and a ref mutation does not do that. */
  const [ephemeralChannel, setEphemeralChannel] = useState<RealtimeChannel | null>(null)

  // The bus is stable across renders — consumers can subscribe in
  // useEffect without forcing reconnects.
  const bus = useMemo(() => new EventBus(), [])

  // Refs so the running effect can read the most recent values without
  // resubscribing on every state change.
  const lastSeqRef = useRef<number | null>(initialLastSeq)
  const seenSeqsRef = useRef<Set<number>>(new Set())
  // FIFO order of insertion so we can evict oldest when over `dedupCap`.
  const seenSeqsOrderRef = useRef<number[]>([])
  const channelRef = useRef<RealtimeChannel | null>(null)
  const ephemChannelRef = useRef<RealtimeChannel | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)
  /** False until the first successful subscribe, so a resync fires only on a RE-connect. */
  const hasSubscribedRef = useRef(false)
  /**
   * Abandons a subscribe that is still setting up when a newer one starts.
   *
   * A counter again, but for a different job than the one that failed: this decides whether
   * an IN-FLIGHT setup should keep going, never whether a live channel may act. Without it,
   * React Strict Mode's double-invoked effect leaves two subscribes awaiting getSession(),
   * both resume, and both create a channel on the same topic. The server then keeps one and
   * kicks the other. The identity guard stops the loser from driving the connection, but this
   * stops it from ever being created.
   */
  const subscribeTokenRef = useRef(0)
  /**
   * The channel whose connection has already failed, kept until the next teardown.
   *
   * NOT done by nulling `channelRef`, which would be the obvious move: teardown reads
   * `channelRef` to decide what to deregister, so nulling it here would leave the dead channel
   * registered on the topic forever, still receiving broadcasts for a room nobody is watching.
   * A separate marker lets everything else ignore the channel while teardown can still find it.
   *
   * Two things depend on it. A drop reports CHANNEL_ERROR and then CLOSED, and both used to
   * schedule a reconnect, double-stepping the backoff so the first 500 ms retry was skipped.
   * And a replay that resolves AFTER the drop used to write 'live' over 'reconnecting', turning
   * the connection pill green while nothing was connected.
   */
  const abandonedRef = useRef<RealtimeChannel | null>(null)
  /** Set once a subscribe has HELD; only then is the backoff counter safe to reset. */
  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** True once any event has advanced the cursor — after that, the prop must not touch it. */
  const seqAppliedRef = useRef(false)

  /* The callbacks live in refs because the subscribe effect deliberately depends only on
     [roomId, dedupCap]. A caller passing an inline arrow re-creates it every render, and
     without this the effect's closure would keep calling the version captured on mount. */
  const onReplayTruncatedRef = useRef(onReplayTruncated)
  const onResyncRef = useRef(onResync)
  onReplayTruncatedRef.current = onReplayTruncated
  onResyncRef.current = onResync

  /**
   * Re-anchor the replay cursor when the real lastSeq arrives after mount.
   *
   * Every caller passes `snapshot?.lastSeq ?? 0`, and on the first render the snapshot has
   * not resolved, so the hook used to latch 0 into a ref and never hear the real value —
   * useRef and useState both ignore everything after the first render (#639). Replay then
   * ran from the start of the room on every reconnect, re-dispatching the entire session
   * and filling the 500-entry dedup set with history, which evicts the seqs that actually
   * matter. Guarded on seqAppliedRef so a genuine cursor, advanced by a real event, is
   * never dragged backwards by a late-arriving prop.
   */
  useEffect(() => {
    if (seqAppliedRef.current) return
    if (initialLastSeq == null) return
    if (lastSeqRef.current != null && lastSeqRef.current >= initialLastSeq) return
    lastSeqRef.current = initialLastSeq
    setLastSeq(initialLastSeq)
  }, [initialLastSeq])

  useEffect(() => {
    cancelledRef.current = false
    const supabase = createClient()

    const markSeqApplied = (seq: number | null) => {
      if (seq == null) return
      if (seenSeqsRef.current.has(seq)) return false
      seenSeqsRef.current.add(seq)
      seenSeqsOrderRef.current.push(seq)
      while (seenSeqsOrderRef.current.length > dedupCap) {
        const evicted = seenSeqsOrderRef.current.shift()
        if (evicted != null) seenSeqsRef.current.delete(evicted)
      }
      if (lastSeqRef.current == null || seq > lastSeqRef.current) {
        lastSeqRef.current = seq
        setLastSeq(seq)
      }
      /* From here the cursor is real, so the re-anchor effect must stop touching it. */
      seqAppliedRef.current = true
      return true
    }

    const dispatch = (raw: unknown, expectedTopic: 'auth' | 'ephem') => {
      // Validate the envelope shape minimally before emitting.
      if (!raw || typeof raw !== 'object') return
      const env = raw as Partial<LcEvent>
      if (!env.type || typeof env.type !== 'string') return
      const type = env.type as LcEventType

      // Spoof filter: authoritative events MUST have a non-null seq,
      // EXCEPT for the small allowlist (NULL_SEQ_AUTHORITATIVE_TYPES)
      // emitted by server-side routes via lc_send_event(persist=false) —
      // those legitimately don't carry a sequence because they aren't
      // persisted in lc_events.
      if (expectedTopic === 'auth') {
        if (!AUTHORITATIVE_EVENT_TYPES.has(type)) {
          logSpoofRejected(roomId, `unknown auth event type: ${type}`)
          return
        }
        if (env.seq == null && !NULL_SEQ_AUTHORITATIVE_TYPES.has(type)) {
          logSpoofRejected(roomId, `auth event missing seq: ${type}`)
          return
        }
      } else {
        if (!EPHEMERAL_EVENT_TYPES.has(type)) {
          logSpoofRejected(roomId, `unknown ephem event type: ${type}`)
          return
        }
        // Ephemeral events have seq=null by design; nothing to check here.
      }

      // Dedup by seq for authoritative events. Drop if we've seen it.
      if (env.seq != null) {
        const fresh = markSeqApplied(env.seq)
        if (!fresh) return
      }

      bus.emit(env as LcEvent)
    }

    /* `owner` is the channel this replay belongs to. getEventsSince can resolve long after the
       socket dropped, and without an owner to check against, the `finally` below wrote 'live'
       over the 'reconnecting' the drop had just set: the pill went green while nothing was
       connected. That is the same class of lie as the stale slide #639 was about. */
    const replay = async (owner: RealtimeChannel | null) => {
      if (cancelledRef.current) return
      const stillOurs = () =>
        !cancelledRef.current && channelRef.current === owner && abandonedRef.current !== owner
      try {
        setStatus('replaying')
        const result = await getEventsSince(roomId, lastSeqRef.current ?? 0)
        if (!stillOurs()) return
        if (result.error) {
          logger.warn('useRoomChannel: replay failed', {
            roomId,
            error: result.error,
          })
          setError(result.error)
          return
        }
        const events = result.events ?? []
        logReplay(roomId, events.length)
        for (const event of events) {
          dispatch(event, 'auth')
        }
        setError(null)
        if (result.truncated) {
          // The replay buffer returned exactly the row cap — there may be
          // additional events past the cap that we'll never see. Surface
          // this to the caller so they can re-hydrate from a fresh snapshot.
          logger.warn('useRoomChannel: replay truncated, requesting snapshot refetch', { roomId })
          onReplayTruncatedRef.current?.()
        }
      } catch (err) {
        logger.error('useRoomChannel.replay', err, { roomId })
      } finally {
        // Only the channel that started this replay may declare the room live.
        if (stillOurs()) setStatus('live')
      }
    }

    const scheduleReconnect = () => {
      if (cancelledRef.current) return
      const attempt = Math.min(
        reconnectAttemptsRef.current,
        RECONNECT_BACKOFF_MS.length - 1,
      )
      const delay = RECONNECT_BACKOFF_MS[attempt]
      reconnectAttemptsRef.current += 1
      setStatus('reconnecting')
      logger.warn('useRoomChannel: scheduling reconnect', {
        roomId,
        attempt: reconnectAttemptsRef.current,
        delayMs: delay,
      })
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      // subscribe() tears down first, so this cannot leave two channels on one topic.
      reconnectTimerRef.current = setTimeout(() => {
        void subscribe()
      }, delay)
    }

    /* AWAITED, deliberately. removeChannel is async; firing it and re-subscribing in the
       same tick meant a new join landed on a topic the old channel was still registered on,
       the server kicked the older one, and its CLOSED scheduled yet another reconnect. That
       is the loop. Nulling the refs first so nothing can act on a channel being removed. */
    const teardown = async () => {
      const auth = channelRef.current
      const ephem = ephemChannelRef.current
      channelRef.current = null
      ephemChannelRef.current = null
      abandonedRef.current = null
      setEphemeralChannel(null)
      await Promise.allSettled([
        auth ? supabase.removeChannel(auth) : Promise.resolve(),
        ephem ? supabase.removeChannel(ephem) : Promise.resolve(),
      ])
    }

    const subscribe = async () => {
      const token = ++subscribeTokenRef.current
      if (cancelledRef.current) return
      /* Deregister any prior channels BEFORE joining the same topics again. Two channels on
         one topic means the server keeps one and kicks the other, and nothing downstream can
         tell which survived. Awaited, so the join never races the removal. */
      await teardown()
      // Superseded while tearing down: leave the newer attempt to it.
      if (cancelledRef.current || token !== subscribeTokenRef.current) return

      // Race-proof setAuth: ensure the realtime client has the current
      // JWT BEFORE we open a private channel. Without this, the very first
      // subscribe loses to setAuth and the private-channel RLS rejects
      // every event silently — symptom: "I have to refresh".
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          supabase.realtime.setAuth(session.access_token)
        }
      } catch (err) {
        logger.warn('useRoomChannel: setAuth before subscribe failed', { err: String(err) })
      }
      /* Second await point, and the one that actually bit: two effect invocations both
         parked here, both resumed, and both went on to create channels. */
      if (cancelledRef.current || token !== subscribeTokenRef.current) return

      const authChannel = supabase.channel(authoritativeTopic(roomId), {
        config: { private: true },
      })
      const ephemChannel = supabase.channel(ephemeralTopic(roomId), {
        config: { private: true },
      })

      // Bind every authoritative event type so we don't miss anything.
      // Supabase Broadcast's `.on('broadcast', { event }, …)` requires an
      // event filter, so register one listener per known type.
      AUTHORITATIVE_EVENT_TYPES.forEach((type) => {
        authChannel.on('broadcast', { event: type }, ({ payload }) => {
          dispatch(payload, 'auth')
        })
      })
      EPHEMERAL_EVENT_TYPES.forEach((type) => {
        ephemChannel.on('broadcast', { event: type }, ({ payload }) => {
          dispatch(payload, 'ephem')
        })
      })

      /* Claim ownership BEFORE binding the status callback, because SUBSCRIBED can land
         immediately. These used to be assigned at the very END of subscribe(), which is why
         the identity check below has to come after them and not before. */
      channelRef.current = authChannel
      ephemChannelRef.current = ephemChannel

      authChannel.subscribe((channelStatus) => {
        /* IDENTITY, not a generation counter. A superseded channel must never drive the
           connection: its CLOSED would schedule a reconnect, that reconnect would supersede
           it again, and the room would rejoin every 500 ms forever.

           My first attempt keyed this on a monotonic counter and was far worse than the loop
           it fixed. React Strict Mode double-invokes effects in dev, so two subscribes raced;
           the counter had already advanced past the channel that actually won the topic, its
           SUBSCRIBED was discarded, and the branch below simply never ran. Status stayed
           `connecting` forever, replay never ran, and a dropped student silently watched a
           stale slide for the rest of class while the pill claimed to be fine.
           `channelRef.current` cannot drift out of step with reality the way a counter can:
           it either is this channel or it is not. */
        if (cancelledRef.current || channelRef.current !== authChannel) return
        if (channelStatus === 'SUBSCRIBED') {
          /* An ABANDONED channel can come back on its own, and letting it through is fatal.
             The Supabase client runs its own rejoin backoff until removeChannel is called, and
             our teardown is deferred behind the reconnect timer, so there is a window where a
             channel we already gave up on successfully rejoins and emits SUBSCRIBED. It passes
             the identity guard above, because teardown has not run and channelRef still points
             at it.

             If it reached the branch below it would clear our pending retry, destroying the
             planned teardown, and then replay() would correctly refuse to do anything because
             stillOurs() sees the channel is abandoned. Net result: connected, never resynced,
             status stuck on 'replaying', and no retry pending. Permanently desynced with no
             indication, which is the worst outcome this hook can produce and strictly worse
             than the loop it replaced.

             So the retry must SURVIVE. But its remaining backoff can be up to 15 s, and browser
             QA measured exactly that: the catch-up slide landed on the second connection up to
             15 s late. A rogue SUBSCRIBED is proof the network is back, so instead of cancelling
             the retry OR waiting out the backoff, bring it forward. subscribe() tears the rogue
             channel down before rejoining, so this cannot ping-pong. */
          if (abandonedRef.current === authChannel) {
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
            reconnectTimerRef.current = setTimeout(() => {
              void subscribe()
            }, 0)
            return
          }
          /* The connection is up, so cancel any retry still pending from the outage that led
             here. Without this the last scheduled attempt fired anyway, up to 15 s after the
             room was already working: it tore the healthy channel down, rejoined, and its
             catch-up replay lost the identity check and was thrown away, so the student's
             slide arrived on the SECOND connection. Measured three times, each landing within
             400 ms of `last schedule + delayMs`. The state always converged, which is exactly
             why nothing else caught it. */
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current)
            reconnectTimerRef.current = null
          }
          /* NOT an immediate `reconnectAttemptsRef.current = 0`. Resetting the moment a
             resubscribe lands means a connection that drops again straight away goes back to
             the first backoff step, so the retry never escalates past 500 ms. Only a
             connection that HOLDS is evidence the trouble has passed. */
          if (stableTimerRef.current) clearTimeout(stableTimerRef.current)
          stableTimerRef.current = setTimeout(() => {
            if (
              !cancelledRef.current &&
              channelRef.current === authChannel &&
              abandonedRef.current !== authChannel
            ) {
              reconnectAttemptsRef.current = 0
            }
          }, CONNECTION_STABLE_MS)
          logChannelStatus(roomId, 'live')
          const isReconnect = hasSubscribedRef.current
          hasSubscribedRef.current = true
          // Replay missed events. dispatch() dedups so any overlap with
          // events that arrived between the snapshot and now is harmless.
          void replay(authChannel).then(() => {
            /* A reconnect additionally re-reads the snapshot. Replay is relative to
               this client's cursor and so cannot repair anything it never applied;
               the snapshot is absolute. This is what stops a brief drop from leaving
               a student on a stale slide for the rest of the class (#639). */
            if (isReconnect && !cancelledRef.current) onResyncRef.current?.()
          })
        } else if (
          channelStatus === 'CHANNEL_ERROR' ||
          channelStatus === 'TIMED_OUT' ||
          channelStatus === 'CLOSED'
        ) {
          /* One drop, one reconnect. A dropped socket reports CHANNEL_ERROR and then CLOSED,
             and handling both stepped the backoff twice, so the 500 ms retry was skipped and
             the room waited a full second to come back. */
          if (abandonedRef.current === authChannel) return
          abandonedRef.current = authChannel
          setError(`channel ${channelStatus.toLowerCase()}`)
          logChannelStatus(roomId, 'reconnecting', { roomId, dropReason: String(channelStatus) })
          scheduleReconnect()
        }
      })

      // The ephemeral channel doesn't need replay — its events are
      // ephemeral by definition and any miss is expected. Published to callers only
      // once it reports SUBSCRIBED, so nobody can send on a channel that has not joined.
      ephemChannel.subscribe((ephemStatus) => {
        if (cancelledRef.current || ephemChannelRef.current !== ephemChannel) return
        if (ephemStatus === 'SUBSCRIBED') setEphemeralChannel(ephemChannel)
        else if (
          ephemStatus === 'CHANNEL_ERROR' ||
          ephemStatus === 'TIMED_OUT' ||
          ephemStatus === 'CLOSED'
        ) {
          setEphemeralChannel(null)
        }
      })
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !cancelledRef.current) {
        // Phones can keep the WebSocket "open" while silently dropping
        // messages. On every return to foreground, force a replay.
        logger.debug('useRoomChannel: visibility=visible → replay', { roomId })
        /* Passing the ref, which is null when nothing is joined. stillOurs() then compares
           null to null and correctly refuses to declare the room live, but that is a
           coincidence of this call site rather than a designed case: do NOT rewrite it as
           `channelRef.current ?? undefined`, which would make owner undefined, fail the
           identity check for the wrong reason, and bring the lying green pill back. */
        void replay(channelRef.current)
      }
    }

    void subscribe()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelledRef.current = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      if (stableTimerRef.current) clearTimeout(stableTimerRef.current)
      void teardown()
      bus.clear()
    }
    // bus is stable; intentionally exclude from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, dedupCap])

  return { bus, status, error, lastSeq, ephemeralChannel }
}
