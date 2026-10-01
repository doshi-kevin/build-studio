# Live Classroom Broadcast Layer

Foundation primitives for the Broadcast-based realtime architecture (Phase 0 of the migration plan).

| File | Purpose |
|------|---------|
| `types.ts` | Discriminated-union event types (`LcEvent`), envelope shape, topic helpers (`authoritativeTopic`, `ephemeralTopic`), and the allow-list sets used by the spoof filter |
| `event-bus.ts` | Tiny per-channel pub/sub. Lets multiple consumer hooks subscribe to a typed slice of events without each opening their own Supabase channel |
| `use-room-channel.ts` | Resilient hook: subscribes to both authoritative and ephemeral private topics; replays from `lastSeq` on every (re)subscribe; dedupes by seq; rejects spoofed events; reconnects with exponential backoff; re-replays on `document.visibilitychange → visible` |
