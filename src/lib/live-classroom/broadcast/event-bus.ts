// Tiny per-channel pub/sub. Lets multiple consumer hooks (use-slide-sync,
// use-interactions, use-questions, use-drawings, use-presence) share a
// single channel subscription via use-room-channel — they each subscribe
// to a typed slice of the event stream rather than each opening their own
// channel.

import type { LcEvent, LcEventType } from './types'

type Listener<T extends LcEventType> = (event: Extract<LcEvent, { type: T }>) => void
// Widened-listener type used for storage. Each bucket only ever sees
// events whose type matches its key, so dispatch is safe by construction.
type AnyListener = (event: LcEvent) => void

export class EventBus {
  private listeners = new Map<LcEventType, Set<AnyListener>>()

  on<T extends LcEventType>(type: T, listener: Listener<T>): () => void {
    let bucket = this.listeners.get(type)
    if (!bucket) {
      bucket = new Set()
      this.listeners.set(type, bucket)
    }
    const widened = listener as unknown as AnyListener
    bucket.add(widened)
    return () => {
      bucket?.delete(widened)
    }
  }

  emit(event: LcEvent): void {
    const bucket = this.listeners.get(event.type)
    if (!bucket) return
    for (const listener of bucket) {
      try {
        listener(event)
      } catch {
        // A misbehaving listener must not break sibling listeners or the
        // channel subscription. Errors are swallowed deliberately.
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
