/**
 * athena-core — the streaming loop every Athena surface answers through.
 *
 * Two things live here, and they are two halves of one guarantee: what the
 * student SEES arrive is what the server actually did.
 *
 * 1. **The run channel.** Every lookup a turn performs reports itself, so the
 *    dock's "Looking things up…" card shows the real work instead of a fixed
 *    guess. Events raised before the response body exists are buffered and
 *    flushed the instant it opens; after that they go out as they happen.
 *
 * 2. **The response stream.** Model text is scrubbed of anything
 *    directive-shaped on the way through, a partial marker straddling a chunk
 *    boundary is held back, and the caller's own directive — chosen
 *    server-side — is appended after the answer.
 *
 * Surface-agnostic on purpose (design doc §2, "core seams"): nothing here knows
 * about students, courses, retrieval or prompts. The caller supplies a
 * `prepare()` that returns something with a `textStream`, and a `tail()` that
 * returns the directive text to append (or ''). That is the whole contract, and
 * it is what lets the professor surfaces converge onto this loop later without
 * this file changing.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import { buildRunDirective, directiveHoldback, stripDirectives, type AthenaRunEvent } from '@/lib/ai/athena-directive'
import { ATHENA_NOTICE_PREFIX } from '@/lib/ai/config'

// ── The run channel ───────────────────────────────────────────────────────────

export interface AthenaRunChannel {
  /** Report one event now (buffered until the stream opens). */
  record(event: AthenaRunEvent): void
  /** Time one lookup and report its start and finish under a student-facing name. */
  timed<T>(id: string, name: string, work: () => Promise<T>, describe: (result: T) => string): Promise<T>
  /**
   * Every row this turn reported, for persistence.
   *
   * The markers on the stream are what make a row appear the moment it happens;
   * this log is what makes it still be there tomorrow. It is DATA — never store
   * the markers, because message text is re-parsed on every thread reopen and a
   * stored directive would drive the app again on each visit.
   */
  readonly log: readonly AthenaRunEvent[]
}

/** The half `streamAthenaResponse` drives; callers only ever see the interface above. */
interface RunChannelInternals extends AthenaRunChannel {
  /** Flush what was buffered and go live. */
  open(send: (event: AthenaRunEvent) => void): void
  /**
   * Stop emitting. A lookup can outlive the stream — the student closes the dock
   * mid-answer, or a slow tool resolves after the last token — and enqueueing
   * onto a closed controller THROWS, which would surface as a 500 on a turn the
   * student has already finished with.
   */
  close(): void
}

export function createRunChannel(): AthenaRunChannel {
  const buffered: AthenaRunEvent[] = []
  const log: AthenaRunEvent[] = []
  let emit = (event: AthenaRunEvent) => {
    buffered.push(event)
  }

  const channel: RunChannelInternals = {
    log,
    record(event) {
      log.push(event)
      emit(event)
    },
    async timed(id, name, work, describe) {
      const startedAt = Date.now()
      channel.record({ phase: 'start', id, name, detail: '' })
      let result: Awaited<ReturnType<typeof work>>
      try {
        result = await work()
      } catch (err) {
        /* Close the row before rethrowing. A 'start' with no matching 'done' is
           a row the client draws as a spinner and never takes down — so a
           failing lookup did not read as "this failed", it read as "this is
           still going", forever, with no answer behind it.
           Seen in production: a rejected Pinecone key left "Course materials"
           spinning indefinitely while the turn was already dead.
           'done' rather than a new phase on purpose — the wire format is
           'start' | 'done' and the client already renders a done row with its
           detail, so this needs no protocol or renderer change. */
        channel.record({
          id,
          name,
          phase: 'done',
          detail: 'unavailable',
          ms: Date.now() - startedAt,
        })
        throw err
      }
      channel.record({ phase: 'done', id, name, detail: describe(result), ms: Date.now() - startedAt })
      return result
    },
    open(send) {
      for (const event of buffered) send(event)
      buffered.length = 0
      emit = send
    },
    close() {
      emit = () => {}
    },
  }
  return channel
}

// ── The response stream ───────────────────────────────────────────────────────

export interface AthenaStreamOptions<T extends { textStream: AsyncIterable<string> }> {
  /** The channel the caller reported its pre-model lookups into. */
  run: AthenaRunChannel
  /**
   * Everything the answer needs, run INSIDE the response stream.
   *
   * It must not run before: retrieval takes ~1s, so by the time the browser had
   * a stream to read every pre-model lookup would already have finished and its
   * start+done pair flushed together — the card would paint fully ticked and
   * "Looking things up…" would never once be seen.
   */
  prepare: () => Promise<T>
  /**
   * The directive to append after the answer, or '' for none. Called once, after
   * the last token, so a tool that ran late still counts. Whatever it returns
   * bypasses the scrub deliberately: the scrub is for MODEL text, and this is
   * the caller's own provenance-checked output.
   */
  tail?: () => string
  /** `logger` source tag, e.g. 'api.chat.POST'. */
  source: string
  /** Extra logger context (section id, etc.). */
  context?: Record<string, unknown>
}

/**
 * Wrap a prepared turn as a plain-text streaming `Response`.
 *
 * The scrub is not belt-and-braces. The client takes the FIRST directive match,
 * so one injected through RAG'd course material, a tool-result string, an
 * attachment or a crafted link would outrank the server's — and would persist,
 * re-firing on every reopen.
 */
export function streamAthenaResponse<T extends { textStream: AsyncIterable<string> }>(
  opts: AthenaStreamOptions<T>,
): Response {
  const run = opts.run as RunChannelInternals
  let aborted = false
  let streamOpen = true

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      let carry = ''
      /* Live from here on — and crucially BEFORE `prepare()` is awaited, so each
         row appears the moment its lookup starts instead of arriving pre-ticked.
         Moving this below prepare puts the entire card behind retrieval and
         reinstates the bug the ordering exists to fix: "Looking things up…" is a
         state the component can draw and would never once be seen.
         `athena-chat-run-streaming.test.ts` pins it. */
      run.open((event) => {
        if (!streamOpen) return
        controller.enqueue(encoder.encode(buildRunDirective(event)))
      })

      let result: T
      try {
        result = await opts.prepare()
      } catch (err) {
        logger.error('streamAthenaResponse: failed to prepare the turn', err, {
          source: opts.source,
          ...opts.context,
        })
        streamOpen = false
        run.close()
        /* Enqueue THEN close, rather than controller.error().
           Erroring aborts the body, and the client discards the partial stream
           with it — including the run rows already delivered — so the lookup
           card is left mid-flight and the student sees nothing at all. Verified
           both ways in production: erroring reproduced the original hang;
           enqueue-then-close closed the card in 274ms and showed the sentence.
           The marker stays on the text so the client can render it as a notice
           rather than as Athena's own words; AthenaChat strips it at the render
           site. */
        try {
          controller.enqueue(
            encoder.encode(
              `${ATHENA_NOTICE_PREFIX}Athena couldn't reach your course materials just now. Try again in a moment — if it keeps happening, tell your professor.`,
            ),
          )
        } catch {
          /* Reader already gone; the log above is the record. */
        }
        controller.close()
        return
      }

      try {
        for await (const chunk of result.textStream) {
          carry = stripDirectives(carry + chunk)
          // Hold back exactly the unterminated marker opener, if any, so one
          // split across chunks is caught on the next pass — and nothing more,
          // so ordinary prose streams without delay.
          const hold = directiveHoldback(carry)
          if (carry.length > hold) {
            controller.enqueue(encoder.encode(carry.slice(0, carry.length - hold)))
            carry = carry.slice(carry.length - hold)
          }
        }
        if (carry) controller.enqueue(encoder.encode(stripDirectives(carry)))
        const tail = opts.tail?.() ?? ''
        if (tail) controller.enqueue(encoder.encode(tail))
        streamOpen = false
        run.close()
        controller.close()
      } catch (err) {
        // Error the body instead of closing it: a silent close hands the student
        // a truncated answer that looks finished. An abort is not a failure —
        // the client left on purpose, so don't log it as one.
        if (!aborted) {
          logger.error('streamAthenaResponse: stream failed', err, { source: opts.source, ...opts.context })
        }
        streamOpen = false
        run.close()
        controller.error(err)
      }
    },
    cancel() {
      aborted = true
      streamOpen = false
      run.close()
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
