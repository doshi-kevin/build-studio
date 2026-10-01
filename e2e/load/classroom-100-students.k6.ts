/* eslint-disable import/no-anonymous-default-export */
// @ts-expect-error — k6 ships its own types via the k6 CLI, not as an npm package.
import http from 'k6/http'
// @ts-expect-error — k6 ships its own types via the k6 CLI, not as an npm package.
import { check, sleep } from 'k6'
//
// k6 load test scaffold — drives 1 prof + 100 simulated students through
// a Live Classroom session: snapshot fetch, broadcast subscribe, slide
// advance, poll responses, drawing strokes, Q&A.
//
// This is a SCAFFOLD. To execute it you need to:
//   1. Install k6 (https://k6.io/docs/get-started/installation/)
//   2. Provide LIVE_CLASSROOM_ROOM_ID + a long-lived JWT for the student fleet
//      via env vars (see below)
//   3. Run: k6 run e2e/load/classroom-100-students.k6.ts
//
// k6 doesn't natively support Supabase Realtime WebSockets without a custom
// Go extension (xk6-websockets). The Phase 4.5 task is to either:
//   (a) write the xk6 extension and ship the binary, or
//   (b) use Artillery/locust which support WS out of the box, or
//   (c) keep this scaffold and replace with synthetic Playwright fleet
//       (browser-driven, more honest representation of real client cost).
//
// For YC launch the recommended path is (c) — see e2e/load/load-README.md.

interface EnvVars {
  SUPABASE_URL: string
  STUDENT_JWT: string
  ROOM_ID: string
}

// k6 injects __ENV at runtime; declared loosely here for the scaffold.
declare const __ENV: Record<string, string>
const env = (__ENV as unknown) as EnvVars

export const options = {
  scenarios: {
    students: {
      executor: 'constant-vus',
      vus: 100,
      duration: '5m',
    },
  },
  thresholds: {
    // p95 of HTTP requests under 500ms (the broadcast loop should be <100ms but
    // HTTP-level snapshot/persist calls dominate this metric).
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
}

export default function () {
  // 1. Hit the snapshot endpoint (replicates getRoomSnapshot via REST).
  const snapshotRes = http.post(
    `${env.SUPABASE_URL}/rest/v1/rpc/lc_get_room_snapshot`,
    JSON.stringify({ p_room_id: env.ROOM_ID }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.STUDENT_JWT}`,
        apikey: env.STUDENT_JWT,
      },
      tags: { op: 'snapshot' },
    },
  )
  check(snapshotRes, { 'snapshot 200': (r: { status: number }) => r.status === 200 })

  // 2. Idle for ~30s to simulate slide viewing time.
  sleep(30)

  // 3. Submit a poll response (simulating a student answering).
  // ⚠ WS-side broadcast subscribe + drawing stroke firing is NOT covered
  //   here — see header comment for the full story.
}
