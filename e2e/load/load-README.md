# Live Classroom Load Tests

Validates the Broadcast architecture can sustain 100 concurrent students per session within Supabase plan-tier limits before Phase 5 (cutover & deletion of legacy classroom).

## Why this matters

Per the migration plan:

- Drawing strokes at 100 users × 30Hz on one room = 3000 msg/sec on a single broadcast topic. Supabase Pro currently caps broadcast message rate at ~2500 msg/sec project-wide. **This is over the limit.**
- Mitigations on the table:
  1. Cap per-user stroke broadcast rate to 15Hz (still smooth perceptually).
  2. Move drawings to a dedicated transport (e.g. Liveblocks) for the drawing-only path.
  3. Upgrade to Team plan for ~10× the message budget.

Phase 5 (the destructive cutover) **must not** ship until either (a) the load test passes, or (b) one of the mitigations above is in place.

## Plan-tier reference (verify before running)

| Plan | Concurrent connections | Broadcast msg/sec/project | Channel join rate |
|---|---|---|---|
| Free | 200 | low | low |
| Pro | 500 | ~2500 | ~100/sec |
| Team | 1500 | ~25000 | ~500/sec |

Numbers from Supabase docs as of 2026-04 — confirm in dashboard before relying on them.

## Files

- `classroom-100-students.k6.ts` — k6 scaffold for HTTP-side load (snapshot, persist).
- (planned) `playwright-fleet.spec.ts` — browser-driven 100-student fleet (the real load test, since k6 doesn't natively speak Supabase Realtime WebSockets without an extension).

## Running

The scaffold today only validates HTTP-side throughput. For the WebSocket path, the recommended approach is a Playwright fleet:

```bash
PLAYWRIGHT_FLEET=100 npx playwright test e2e/load/playwright-fleet.spec.ts
```

(spec is TBD — track with the cutover task)

## What success looks like

- p95 broadcast event delivery < 500ms with 100 concurrent students
- Zero CHANNEL_ERROR / TIMED_OUT events during a 5-minute soak
- Aggregate updates arrive within 1s of the last response
- Drawings render smoothly (subjective; record video) on a mid-tier laptop

## What failure looks like

- p95 > 1s — bottleneck likely in `pg_advisory_xact_lock` contention on aggregate trigger; consider materializing the count column instead of recomputing.
- WebSocket disconnects under load — concurrent connection cap hit; needs plan upgrade.
- Drawings choppy — broadcast msg/sec cap hit; rate-cap stroke broadcasts to 15Hz/user.
