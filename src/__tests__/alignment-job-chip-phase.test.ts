// #632: the progress chip named a phase that was not doing the work.
//
// On a real cold run every mapping step reported `done` at ~50s, then the job's status
// stayed `running` for a further ~3 minutes. Throughout that window the chip read
// "Rolling up coverage and finding gaps" — attributing the wait to reduce, which is
// deterministic string assembly with no model call and finishes in about a second.
//
// Four candidate causes are ruled out on the issue and the real one is still unknown, so
// the fix is NOT to name a different phase: it is to stop claiming any phase we cannot
// verify, and to admit the wait once it stops looking like normal progress.
//
// narratePhase is not exported (it is a module-local helper in a client component), so
// these assert against the source. Crude, but it pins the two properties that regress:
// the false claim must not come back, and the threshold branch must survive.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RAW = readFileSync(
  join(process.cwd(), 'src/components/professor/assistant/cards/AlignmentJobChip.tsx'),
  'utf8',
)

/* Comments stripped, because the fix's own comment QUOTES the old copy to explain what
   went wrong — and that documentation is worth keeping. Asserting against the raw file
   would fail on the explanation of the bug rather than on the bug. */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('#632: the chip stops naming a phase it cannot verify', () => {
  it('no longer claims the reduce step is doing the work', () => {
    /* The exact string from the report. Reintroducing it would restore a chip that tells
       the professor work is happening a minute after the measurable work finished. */
    expect(SRC).not.toContain('Rolling up coverage')
  })

  it('keeps the old copy in a comment, so the reasoning is not lost', () => {
    // Documentation, not behaviour: the next person to touch this should see what the
    // chip used to claim and why that was wrong.
    expect(RAW).toContain('Rolling up coverage')
  })

  it('says something true while the job finishes', () => {
    expect(SRC).toContain("'Finishing up'")
  })

  it('admits the wait once it stops looking like normal progress', () => {
    expect(SRC).toMatch(/SLOW_FINALISE_MS\s*=\s*30_000/)
    expect(SRC).toMatch(/finalisingForMs > SLOW_FINALISE_MS/)
    expect(SRC).toContain('taking longer than usual')
  })

  it('times the wait from when mapping actually finished, not from job start', () => {
    /* Measuring from `started_at` would trip the threshold on any long-but-healthy run,
       which is the opposite of the point: the complaint is specifically about the window
       AFTER the steps are done. */
    // The latch starts only when NO step is still running…
    expect(SRC).toMatch(/progress\.every\([\s\S]{0,40}?p\.status !== 'running'/)
    // …and the elapsed handed to narratePhase is measured from that latch, not job start.
    expect(SRC).toMatch(/finalisingSince \? now - finalisingSince : 0/)
    expect(SRC).not.toMatch(/narratePhase\(job, [^)]*started_at/)
  })

  it('keeps naming the real phase while a step is genuinely running', () => {
    // The per-step line is accurate and must not be collateral damage.
    expect(SRC).toContain('Mapping ${latest.label} to ABET outcomes')
  })
})
