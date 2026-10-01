// A directive is how Athena moves the app the student is looking at.
//
// The student chat streams plain text (TextStreamChatTransport), so there are no
// tool-call parts on the client the way the professor dock has them. Instead the
// route APPENDS a directive to the end of the stream when a tool has produced a
// place worth taking the student. The client strips it before render and acts on
// it once.
//
// The model must not be able to produce one — a course page carrying the syntax
// into the RAG context would otherwise teach it to drive the app, and since the
// parser takes the FIRST match an injected directive would beat the route's. So
// model text is scrubbed of anything directive-shaped (`stripDirectives`) before
// the route's own is appended. Provenance is enforced, not assumed.
//
// The DIRECTIVE is never persisted: the route scrubs the answer before storing
// it, so reopening a thread re-reads the words without re-navigating. The run
// ROWS are persisted, separately and as data rather than markers — see
// `messageRun` in conversation-utils.ts for why that distinction is the whole
// safety property.

import { isInAppPath } from '@/lib/routes/safe-path'

/** `[[athena:node:module_item:<uuid>]]` — a roadmap node to open. */
const DIRECTIVE_RE = /\[\[athena:node:([a-z_]+:[0-9a-fA-F-]{6,})\]\]/

/** `[[athena:run:<base64>]]` — one lookup starting or finishing. Same provenance
 *  rule as the node directive: the route emits these, the model cannot, because
 *  model text is scrubbed of everything directive-shaped first. */
const RUN_RE = /\[\[athena:run:([A-Za-z0-9+/=]{0,600})\]\]/g

/** `[[athena:propose:<base64>]]` — drive to a pre-filled app surface (N5). Same
 *  provenance rule again, and it matters more here than anywhere else: the
 *  payload is a route the app will navigate to, so a model-authored one would
 *  be an open redirect with the student's session attached. The route builds
 *  this from the typed registry; model text never survives the scrub.
 *
 *  Far wider than the run marker because this one can carry a drafted note:
 *  1000 characters of prose become ~2100 once URI-encoded (a space costs three
 *  bytes) and base64'd. A bound that under-matches here would silently render
 *  the whole marker as text in the answer. */
const PROPOSE_RE = /\[\[athena:propose:([A-Za-z0-9+/=]{0,3000})\]\]/

/** Every directive-shaped span, however malformed — used to scrub MODEL text
 *  before the route appends its own. Deliberately looser than DIRECTIVE_RE:
 *  this one is a censor, so it should over-match, not under-match. The bound is
 *  wide enough to swallow the largest real payload (a propose marker with a
 *  full-length draft); base64 has no `]`, so the span still can't run away past
 *  the closing brackets. */
const ANY_DIRECTIVE_RE = /\[\[athena:[^\]]{0,3000}\]\]/g

/** A half-streamed directive, so it never flashes as raw text mid-answer: any
 *  prefix of `[[athena:…]]` sitting at the very end of the text so far. Anchored
 *  at the end and requiring the opening bracket, so a citation being streamed
 *  ("[Transformers, page 14") is untouched. */
const PARTIAL_RE = /\[{1,2}(a(t(h(e(n(a(:[^\]]*)?)?)?)?)?)?)?\]{0,2}$/

export function buildNodeDirective(nodeKey: string): string {
  return `\n\n[[athena:node:${nodeKey}]]`
}

// ── The run channel — what Athena actually looked up ───────────────────────────
//
// The dock shows a "Looking things up…" card while she works. Those rows used to
// be invented on the client, which meant every answer claimed the same two
// lookups whether they ran or not. These events are the real thing: the route
// times each lookup it performs and each tool the model chooses to call, and
// emits one marker per start and per finish, in the stream, as it happens.
//
// The MARKERS are never persisted — they are appended to the stream rather than
// being part of the model's text, and the route scrubs what it stores. The
// events they carry are, under `ai_messages.metadata.run`, so an old thread
// still shows its cards. Data can be rendered; a marker would be re-parsed, and
// the propose directive rides this same channel.

export interface AthenaRunEvent {
  /** 'start' opens a row; 'done' completes the row with the same id. */
  phase: 'start' | 'done'
  /** Stable within a turn, so a start and its done pair up. */
  id: string
  /** Friendly name for the student — never a function name. */
  name: string
  /** What it found. Empty on 'start'. */
  detail: string
  /** Real measured duration, on 'done' only. */
  ms?: number
  /** 'plan' rows are a propose tool's declared steps and draw their own card
   *  (§14.5); absent means an ordinary lookup. */
  group?: 'plan'
  /** Plan rows only: the proposing tool's own student-facing name ("a challenge
   *  that fits"), so the card that never folds can say what it set up instead of
   *  counting its own internal steps. */
  card?: string
}

/** Keys are short because the payload rides inside a stream marker. */
interface WireEvent {
  p: 'start' | 'done'
  i: string
  n: string
  d: string
  m?: number
  g?: 'plan'
  c?: string
}

/** Base64 of URI-encoded JSON: the alphabet contains no `]`, so the marker can
 *  never be terminated early by its own payload, and any character survives. */
export function buildRunDirective(event: AthenaRunEvent): string {
  const wire: WireEvent = {
    p: event.phase,
    i: event.id,
    n: event.name,
    // Bounded: a runaway detail string would blow past the censor's span limit
    // and start rendering as text.
    d: event.detail.slice(0, 120),
    ...(event.ms === undefined ? {} : { m: Math.round(event.ms) }),
    ...(event.group === undefined ? {} : { g: event.group }),
    ...(event.card === undefined ? {} : { c: event.card.slice(0, 60) }),
  }
  return `[[athena:run:${btoa(encodeURIComponent(JSON.stringify(wire)))}]]`
}

function decodeRunEvent(payload: string): AthenaRunEvent | null {
  try {
    const wire = JSON.parse(decodeURIComponent(atob(payload))) as WireEvent
    if (!wire || (wire.p !== 'start' && wire.p !== 'done')) return null
    if (typeof wire.i !== 'string' || typeof wire.n !== 'string') return null
    return {
      phase: wire.p,
      id: wire.i,
      name: wire.n,
      detail: typeof wire.d === 'string' ? wire.d : '',
      ...(typeof wire.m === 'number' ? { ms: wire.m } : {}),
      ...(wire.g === 'plan' ? { group: 'plan' as const } : {}),
      ...(typeof wire.c === 'string' ? { card: wire.c } : {}),
    }
  } catch {
    // A half-streamed or corrupt payload is dropped, never thrown: a malformed
    // marker must cost the student a row, not the whole answer.
    return null
  }
}

// ── The propose channel — drive to a pre-filled surface ────────────────────────

export interface AthenaProposal {
  /** An in-app path, always. Validated on decode, not trusted. */
  route: string
  /** What the navigation card shows: "Challenges · Graph Traversal Sprint". */
  label: string
  /** One sentence for the receipt line under the answer, naming what she did
   *  and what is now the student's move. Written by the tool that proposed it —
   *  a generic sentence here was worse than none, because it described the
   *  roadmap for every proposal, including the two that never touch it. */
  said: string
  /** A drafted value for the target surface's form, when the proposal carries
   *  prose rather than just an id (§14.4). The shell hands this to the pre-fill
   *  handoff; it never reaches the URL. */
  prefill?: { kind: PrefillKind; text: string }
}

/** Kept in step with `PrefillKind` in use-athena-prefill.ts. Declared here too
 *  because this module is server-reachable and that hook is client-only. */
type PrefillKind = 'lc_question' | 'booking_note'
const PREFILL_KINDS: readonly PrefillKind[] = ['lc_question', 'booking_note']

/** A draft is a form value, not a document — long enough for a real question or
 *  a note to a professor, short enough that a runaway generation can't blow the
 *  marker past the censor's span limit. */
const MAX_PREFILL = 1000

export function buildProposeDirective(proposal: AthenaProposal): string {
  const wire = {
    r: proposal.route,
    l: proposal.label.slice(0, 120),
    s: proposal.said.slice(0, 160),
    ...(proposal.prefill
      ? { k: proposal.prefill.kind, t: proposal.prefill.text.slice(0, MAX_PREFILL) }
      : {}),
  }
  return `\n\n[[athena:propose:${btoa(encodeURIComponent(JSON.stringify(wire)))}]]`
}

function decodeProposal(payload: string): AthenaProposal | null {
  try {
    const wire = JSON.parse(decodeURIComponent(atob(payload))) as {
      r?: unknown
      l?: unknown
      s?: unknown
      k?: unknown
      t?: unknown
    }
    // The provenance scrub is the primary defence; this is the second one,
    // because the value ends up in `router.push` and a leaked marker must not
    // become an off-site redirect inside a trusted session.
    if (!isInAppPath(wire?.r)) return null
    // An unrecognised kind drops the draft, not the drive: she still takes the
    // student to the right page, just without a pre-filled form.
    const kind = PREFILL_KINDS.find((k) => k === wire.k)
    return {
      route: wire.r,
      label: typeof wire.l === 'string' ? wire.l : '',
      said: typeof wire.s === 'string' ? wire.s : '',
      ...(kind && typeof wire.t === 'string'
        ? { prefill: { kind, text: wire.t.slice(0, MAX_PREFILL) } }
        : {}),
    }
  } catch {
    return null
  }
}

/** Remove anything directive-shaped from text the MODEL produced. */
export function stripDirectives(text: string): string {
  return text.replace(ANY_DIRECTIVE_RE, '')
}

/** The widest span the censor will match, plus its brackets. A marker longer
 *  than this can never be scrubbed, so it is also the point past which holding
 *  text back buys nothing. Kept next to `ANY_DIRECTIVE_RE` because the two
 *  numbers have to move together — they did not, once, and a marker over the
 *  old fixed holdback could straddle a chunk boundary uncaught. */
const MAX_DIRECTIVE_SPAN = 3000 + '[[athena:]]'.length

const OPENER = '[[athena:'
/** Any prefix of the opener sitting at the very end of the text so far. */
const OPENER_PARTIAL_RE = /\[(\[(a(t(h(e(n(a(:)?)?)?)?)?)?)?)?$/

/**
 * How many trailing characters the route must hold back before flushing.
 *
 * `stripDirectives` has already removed every COMPLETE marker, so anything
 * opener-shaped still present is either unterminated (its `]]` hasn't streamed
 * yet) or a fragment of the opener itself. Holding exactly that much back — and
 * nothing more — is what lets a marker split across chunks be caught on the
 * next pass.
 *
 * This replaced a fixed 220-character holdback. Fixed was both too small (the
 * propose payload widened the censor's span to ~3000, so a long injected marker
 * straddled the boundary and escaped the scrub) and, at the size that would
 * have been large enough, far too big — a 3000-character holdback delays the
 * tail of every answer by a paragraph. Opener-driven is correct at any span and
 * costs nothing on text that contains no marker.
 */
export function directiveHoldback(text: string): number {
  const open = text.lastIndexOf(OPENER)
  // An opener older than the widest matchable span can never complete into a
  // marker, so there is nothing left to wait for.
  if (open !== -1 && text.length - open <= MAX_DIRECTIVE_SPAN) return text.length - open
  return text.match(OPENER_PARTIAL_RE)?.[0].length ?? 0
}

export interface ParsedAnswer {
  /** The answer as the student should see it — directives removed. */
  text: string
  /** The roadmap node key to open, if the route asked for one. */
  gotoNode: string | null
  /** The pre-filled surface to drive to, if a propose tool ran. */
  proposal: AthenaProposal | null
  /** Every lookup this turn reported, in the order they happened. */
  run: AthenaRunEvent[]
}

export function parseAthenaDirective(raw: string): ParsedAnswer {
  const match = raw.match(DIRECTIVE_RE)
  const proposeMatch = raw.match(PROPOSE_RE)
  const run: AthenaRunEvent[] = []
  // Run markers land BETWEEN runs of answer text (a lookup finishing mid-stream),
  // so they are stripped globally, not just off the end.
  for (const m of raw.matchAll(RUN_RE)) {
    const event = decodeRunEvent(m[1])
    if (event) run.push(event)
  }
  const text = raw
    .replace(RUN_RE, '')
    .replace(PROPOSE_RE, '')
    .replace(DIRECTIVE_RE, '')
    .replace(PARTIAL_RE, '')
    .trimEnd()
  return {
    text,
    gotoNode: match?.[1] ?? null,
    proposal: proposeMatch ? decodeProposal(proposeMatch[1]) : null,
    run,
  }
}
