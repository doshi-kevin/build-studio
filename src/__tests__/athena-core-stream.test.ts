// @vitest-environment node
//
// The streaming loop moved out of /api/chat into athena-core/stream.ts, which is
// the first time it can be driven directly. What it guarantees is a sequencing
// contract, and every clause of it fails SILENTLY when broken:
//
//   1. the body opens BEFORE the lookups run, and rows go out as they happen —
//      get this wrong and the run card paints fully ticked, which is exactly the
//      bug the extraction was meant to make un-reintroducible on a second surface.
//   2. model text is scrubbed of anything directive-shaped, INCLUDING a marker
//      split across chunk boundaries, while the caller's own tail — chosen
//      server-side — is appended unscrubbed. The client takes the FIRST match, so
//      a survivor doesn't merely appear, it outranks the server's directive.
//   3. ordinary prose is not held back, or every answer streams a paragraph late.
//   4. a lookup that outlives the stream must not throw. Enqueueing onto a
//      cancelled controller raises `TypeError: Invalid state: Controller is
//      already closed` (verified against this Node's stream implementation) — on
//      a turn the student has already walked away from, that surfaces as a 500.
//   5. a failed prepare closes the body with a NOTICE-marked sentence. Erroring
//      instead makes the client discard the partial stream — the run rows go with
//      it and the lookup card spins forever on a dead turn.
//   6. a lookup whose work throws still closes its row, or that card spins forever.
//
// The scrub/holdback ALGORITHM is pinned in athena-directive.test.ts against a
// hand-copied loop; these tests run the real one, so the two can no longer drift
// apart unnoticed.
import { describe, it, expect, vi } from 'vitest'
import { createRunChannel, streamAthenaResponse } from '@/lib/ai/athena-core/stream'
import {
  buildNodeDirective,
  buildRunDirective,
  parseAthenaDirective,
  type AthenaRunEvent,
} from '@/lib/ai/athena-directive'
import { ATHENA_NOTICE_PREFIX } from '@/lib/ai/config'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const start = (id: string): AthenaRunEvent => ({ phase: 'start', id, name: id, detail: '' })
const done = (id: string, detail = ''): AthenaRunEvent => ({ phase: 'done', id, name: id, detail })

/** A textStream the test drives, chunk by chunk. */
async function* chunks(...parts: string[]) {
  for (const part of parts) yield part
}

/** Split text into fixed-size pieces, the way a real token stream arrives. */
async function* sliced(text: string, size: number) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}

function deferred() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { gate, release }
}

describe('createRunChannel — what the turn reports', () => {
  it('opens a lookup row before the work resolves and closes it with what it found', async () => {
    const run = createRunChannel()
    const { gate, release } = deferred()

    const pending = run.timed(
      'materials',
      'Course materials',
      async () => {
        await gate
        return ['p14', 'p15']
      },
      (pages) => `${pages.length} pages`,
    )

    // The start row is the entire point of the channel: reported while the work
    // is still in flight, not alongside its result.
    expect(run.log).toEqual([{ phase: 'start', id: 'materials', name: 'Course materials', detail: '' }])

    release()
    await pending

    expect(run.log[1]).toMatchObject({
      phase: 'done',
      id: 'materials',
      name: 'Course materials',
      detail: '2 pages',
    })
    // A real measured duration — the card shows this number to the student.
    expect(typeof run.log[1].ms).toBe('number')
  })
})

describe('streamAthenaResponse — the body opens before the work runs', () => {
  it('flushes rows reported before the body existed, then goes live', async () => {
    const run = createRunChannel()
    // Reported with nowhere to send it yet — buffered, not dropped.
    run.record(start('mastery'))

    const res = streamAthenaResponse({
      run,
      source: 'test',
      prepare: async () => {
        run.record(done('mastery', 'weak on attention'))
        return { textStream: chunks('Attention ', 'is all you need.') }
      },
    })

    const parsed = parseAthenaDirective(await res.text())
    expect(parsed.run.map((e) => `${e.phase}:${e.id}`)).toEqual(['start:mastery', 'done:mastery'])
    expect(parsed.text).toBe('Attention is all you need.')
  })

  it('gives the browser a row to read while prepare is still working', async () => {
    const run = createRunChannel()
    const { gate, release } = deferred()
    let prepared = false

    const res = streamAthenaResponse({
      run,
      source: 'test',
      prepare: async () => {
        run.record(start('materials'))
        await gate
        prepared = true
        return { textStream: chunks('ok') }
      },
    })

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()

    // If prepare ran before the stream opened, this read could not have resolved
    // yet — every row would arrive at once, already ticked.
    expect(new TextDecoder().decode(first.value)).toContain('[[athena:run:')
    expect(prepared).toBe(false)

    release()
    await reader.cancel()
  })

  it('sends a row raised mid-answer between the tokens around it', async () => {
    const run = createRunChannel()

    const res = streamAthenaResponse({
      run,
      source: 'test',
      prepare: async () => ({
        textStream: (async function* () {
          yield 'First. '
          // A tool the model chose to call, resolving mid-stream.
          run.record(done('challenge', 'set one up'))
          yield 'Second.'
        })(),
      }),
    })

    const body = await res.text()
    expect(body.indexOf('[[athena:run:')).toBeGreaterThan(body.indexOf('First.'))
    expect(body.indexOf('[[athena:run:')).toBeLessThan(body.indexOf('Second.'))
  })

  it('streams ordinary prose without holding it back', async () => {
    const run = createRunChannel()
    const { gate, release } = deferred()

    const res = streamAthenaResponse({
      run,
      source: 'test',
      prepare: async () => ({
        textStream: (async function* () {
          yield 'Beam search keeps k candidates.'
          await gate
          yield ' The rest.'
        })(),
      }),
    })

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    // Hangs — and the test times out — if the loop waits for more text before
    // flushing prose that contains no marker.
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('Beam search keeps k candidates.')

    release()
    await reader.cancel()
  })
})

describe('streamAthenaResponse — provenance', () => {
  it('scrubs a model-authored directive split across chunks and appends the real one', async () => {
    const run = createRunChannel()
    // Padded well past any fixed holdback, so the marker straddles boundaries at
    // every chunk size below.
    const injected = `[[athena:node:module_item:${'a'.repeat(40)}]]`
    const SERVERS_NODE = 'module_item:11111111-1111-1111-1111-111111111111'

    for (const size of [1, 7, 40, 512]) {
      const res = streamAthenaResponse({
        run: createRunChannel(),
        source: 'test',
        prepare: async () => ({ textStream: sliced(`Sure!${injected} Attention is…`, size) }),
        tail: () => buildNodeDirective(SERVERS_NODE),
      })

      const parsed = parseAthenaDirective(await res.text())
      // The client takes the FIRST match, so a survivor would beat the server's.
      expect(parsed.gotoNode).toBe(SERVERS_NODE)
      expect(parsed.text).toBe('Sure! Attention is…')
    }
    expect(run.log).toEqual([])
  })

  it('scrubs a fabricated lookup row out of model text while real rows still stream', async () => {
    const run = createRunChannel()
    const fabricated = buildRunDirective({
      phase: 'done',
      id: 'fake',
      name: 'Definitely happened',
      detail: 'nope',
      ms: 10,
    })

    const res = streamAthenaResponse({
      run,
      source: 'test',
      prepare: async () => {
        run.record(done('materials', '2 pages'))
        return { textStream: sliced(`Sure!${fabricated} Attention is…`, 13) }
      },
    })

    const parsed = parseAthenaDirective(await res.text())
    expect(parsed.run.map((e) => e.id)).toEqual(['materials'])
  })

  it('computes the tail after the last token, so a late tool still counts', async () => {
    let nodeFromLateTool: string | null = null

    const res = streamAthenaResponse({
      run: createRunChannel(),
      source: 'test',
      prepare: async () => ({
        textStream: (async function* () {
          yield 'Look at '
          yield 'this module.'
          // The tool resolves as the answer ends — the directive it produced is
          // only knowable after the stream is drained.
          nodeFromLateTool = 'module_item:22222222-2222-2222-2222-222222222222'
        })(),
      }),
      tail: () => (nodeFromLateTool ? buildNodeDirective(nodeFromLateTool) : ''),
    })

    const parsed = parseAthenaDirective(await res.text())
    expect(parsed.gotoNode).toBe('module_item:22222222-2222-2222-2222-222222222222')
    expect(parsed.text).toBe('Look at this module.')
  })

  it('appends nothing when the caller has no directive', async () => {
    const res = streamAthenaResponse({
      run: createRunChannel(),
      source: 'test',
      prepare: async () => ({ textStream: chunks('Just an answer.') }),
      tail: () => '',
    })

    expect(await res.text()).toBe('Just an answer.')
  })
})

describe('streamAthenaResponse — when the turn ends badly', () => {
  it('lets a lookup finish after the student closes the dock, without throwing', async () => {
    const run = createRunChannel()
    const { gate, release } = deferred()

    const res = streamAthenaResponse({
      run,
      source: 'test',
      prepare: async () => {
        run.record(start('slow'))
        await gate
        return { textStream: chunks('too late') }
      },
    })

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await reader.cancel()

    // Enqueueing onto a cancelled controller throws, and this runs on a turn the
    // student already left — unguarded it is a 500 on a request nobody is reading.
    expect(() => run.record(done('slow', 'found 2'))).not.toThrow()
    // Still logged, because the answer is persisted from this log, not the wire.
    expect(run.log.map((e) => e.phase)).toEqual(['start', 'done'])

    release()
  })

  it('tells the student when the turn cannot be prepared, instead of ending silently', async () => {
    const run = createRunChannel()

    const res = streamAthenaResponse({
      run,
      source: 'test',
      prepare: async () => {
        throw new Error('retrieval exploded')
      },
    })

    /* This used to error the body, on the reasoning that a clean close would
       render as "a finished answer with no words in it". The dichotomy was
       error-vs-silent-close, and both lose: production showed the errored
       stream renders as NOTHING — no words and no error — while the lookup card
       kept spinning, so a dead turn was indistinguishable from a slow one. (A
       rejected Pinecone key, 2026-08-25.)
       The third option is the one taken now: say what happened, then close. */
    /* Rejects, so a half-written answer is never presented as finished — and the
       rejection carries the notice prefix, which is the only thing AthenaChat's
       onError/ErrorRow will show the student. A raw error message here renders
       as nothing at all, which is how a dead turn came to look like a slow one.
       Streaming the notice as text instead prints the marker verbatim in the
       reply; that path reads it off `err.message` only. */
    /* Closes with a NOTICE-marked sentence rather than erroring. Erroring the
       body makes the client discard the partial stream — the run rows already
       delivered go with it, and the lookup card is left spinning on a turn that
       is already dead. Both endings were tried in production; this is the one
       where the card resolves and the student is told something.
       The marker stays on the wire so AthenaChat can render it as a notice
       instead of as Athena's own words. */
    const body = await res.text()
    expect(body).toContain(ATHENA_NOTICE_PREFIX)
    expect(body).toMatch(/couldn't reach your course materials/i)
    // The underlying fault stays in the log, never on the student's screen.
    expect(body).not.toMatch(/retrieval exploded/i)
    expect(() => run.record(done('materials'))).not.toThrow()
  })

  it('closes a lookup row when its work throws, so the card cannot spin forever', async () => {
    /* `timed` recorded 'start', awaited, then recorded 'done'. A throw skipped
       the 'done' and left the row open — the client draws an unmatched 'start'
       as a spinner and never takes it down. That is the visible half of the
       failure above: "Course materials" span indefinitely on a turn that was
       already dead. */
    const run = createRunChannel()

    await expect(
      run.timed('materials', 'Course materials', async () => {
        throw new Error('pinecone rejected the key')
      }, () => 'never'),
    ).rejects.toThrow('pinecone rejected the key')

    const phases = run.log.filter((e) => e.id === 'materials').map((e) => e.phase)
    expect(phases).toEqual(['start', 'done'])
    const closed = run.log.find((e) => e.id === 'materials' && e.phase === 'done')
    expect(closed?.detail).toBe('unavailable')
    // The row still has to rethrow, or the caller treats a failed lookup as data.
  })
})
