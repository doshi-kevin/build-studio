# Live Classroom Library

Core utilities for the Live Classroom feature. M1 ships PDF slide synchronization on `postgres_changes`; the `broadcast/` subfolder is Phase 0 of the migration to a Broadcast-based architecture (see `/Users/harshil/.claude/plans/spicy-swimming-cupcake.md`).

| File | Purpose |
|------|---------|
| `snapshot.ts` | `getRoomSnapshot(roomId)` server action — single round-trip used by clients to hydrate room state and obtain the `lastSeq` anchor for replay |
| `replay.ts` | `getEventsSince(roomId, lastSeq)` server action — reads the `lc_events` replay buffer with auth checks |
| `broadcast/` | Phase 0 broadcast primitives (types, event bus, resilient channel hook). See `broadcast/broadcast-README.md`. |
