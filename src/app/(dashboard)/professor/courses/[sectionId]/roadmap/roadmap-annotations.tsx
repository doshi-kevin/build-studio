/**
 * roadmap-annotations — the roadmap redesign's ANNOTATION LAYER + NODE
 * EMPHASIS, ported from tmp/roadmap-ui-concepts/index_final.html (§11/§12).
 *
 * Annotations are the system's voice drawn ON the map — hand-drawn margin
 * notes, flags, pen rings, corner marks, tallies, cross-references and scope
 * rules that project information off a node. Emphasis is the same voice on
 * the card itself (shine/breathe/outline/wash/wiggle/tada) — a property any
 * node can carry (see `em`/`emTone` in prototype-adapter.ts).
 *
 * The layer renders inside React Flow's <ViewportPortal>, so everything is
 * positioned in FLOW coordinates and pans/zooms with the map. Geometry comes
 * from the nodes array (position + measured size) — no DOM measuring of the
 * cards. The annotation DOM itself is built imperatively (exactly like the
 * design prototype) inside two 0×0 layers: `.an-halos` under the cards
 * (tucked tabs) and `.an-notes` above them.
 *
 * One-shot animations ARM ON APPROACH: every annotation starts paused
 * (.an-wait — paused at time 0 holds the first keyframe, so waiting draw-ins
 * are invisible) and plays 450ms after its node scrolls into view.
 *
 * Data: `DEMO_ANNOTATIONS` / `DEMO_EMPHASIS` stand in for the real triage
 * engine (to be wired later). Entries tagged with C-, PF- or U-numbers map to
 * the athena-students use-case catalog. The xref click → pan + flash-ring IS
 * U18's "highlight the node" client action.
 *
 * Type: Client Component helpers (imported only by RoadmapPrototype).
 */
'use client'

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { ViewportPortal, useReactFlow, type Node } from '@xyflow/react'
import { applySamePageLink } from '@/lib/roadmap/same-page-link'
import { resolveTarget } from '@/lib/roadmap/annotation-target'
import { safeAppPath } from '@/lib/routes/safe-path'
import type { CourseModule, Resource, Session, EmphasisKind, EmphasisTone } from '@/lib/roadmap/prototype-adapter'
import type { AnnotationVariant, AnnotationSub, RoadmapAnnotation, EmphasisSpec } from '@/lib/roadmap/prototype-adapter'

// The annotation data types now live in the pure adapter module (so the
// server-side triage engine can import them without touching this client
// file). Re-exported here for existing consumers that import them from the layer.
export type { AnnotationVariant, AnnotationSub, RoadmapAnnotation, EmphasisSpec }

/* ════════════════════════════════════════════════════════════════
   TYPES & TONES
   ════════════════════════════════════════════════════════════════ */
export const AN_TONE: Record<EmphasisTone, string> = {
  alert: '#ef4444', warn: '#f59e0b', ok: '#10b981',
  info: 'oklch(0.56 0.19 260)', slate: '#64748b',
}

/* ════════════════════════════════════════════════════════════════
   NODE EMPHASIS — arm-on-approach hook (the .em-wait dance). The em
   classes live on the React Flow node wrapper (.rf-node), so React
   owns them; CSS routes them onto the card element itself.
   ════════════════════════════════════════════════════════════════ */
const ARM_IO: IntersectionObserverInit = { threshold: 0.6, rootMargin: '0px 0px -18% 0px' }
const ARM_HOLD_MS = 450 /* let the user arrive before the animation plays */

/** True once the referenced element has been well inside the viewport for a
 *  beat — the moment a waiting (.em-wait) card effect should start playing. */
export function useApproachArm(ref: RefObject<HTMLDivElement | null>, active: boolean): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!active || armed) return
    const el = ref.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      timer = setTimeout(() => setArmed(true), ARM_HOLD_MS)
      io.disconnect()
    }, ARM_IO)
    io.observe(el)
    return () => { io.disconnect(); if (timer) clearTimeout(timer) }
  }, [ref, active, armed])
  return armed
}
/** The em-* class(es) for a node wrapper — waiting until armed. */
export const emphasisClass = (em: EmphasisKind | undefined, armed: boolean): string =>
  em ? ` em-${em}${armed ? '' : ' em-wait'}` : ''
/** The tone variable the em-* CSS reads. */
export const emphasisStyle = (em: EmphasisKind | undefined, tone: EmphasisTone | undefined): CSSProperties | undefined =>
  em ? ({ '--t': AN_TONE[tone ?? 'info'] } as CSSProperties) : undefined

/* ════════════════════════════════════════════════════════════════
   GEOMETRY HELPERS — the hand-drawn pen (ported 1:1)
   ════════════════════════════════════════════════════════════════ */
/* seeded jitter (mulberry32) — rough.js re-randomizes every render by
   default, which makes doodles twitch on re-measure; a fixed per-target
   seed keeps every wobble identical across draws */
const mulberry32 = (s: number) => () => {
  s |= 0; s = (s + 0x6d2b79f5) | 0
  let t = Math.imul(s ^ (s >>> 15), 1 | s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const seedOf = (str: string) => [...str].reduce((a, c) => a + c.charCodeAt(0), 7)

/* smooth a point list into quadratic segments through midpoints, ending
   EXACTLY on the last point (an arrowhead sits there) */
function smoothPath(pts: [number, number][]): string {
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2
    const my = (pts[i][1] + pts[i + 1][1]) / 2
    d += ` Q ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}, ${mx.toFixed(1)} ${my.toFixed(1)}`
  }
  const last = pts[pts.length - 1]
  return d + ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`
}
/** The `rule` annotation's pen line as a path `d`: a horizontal span across a
 *  `w`×`h` box, wobbled with the same seeded jitter every other doodle uses.
 *  Exported so the professor's own dividers (real nodes, not annotations) draw
 *  the identical hand — see DividerFlowNode in RoadmapPrototype. */
export function rulePath(w: number, h: number, seed: string): string {
  const rand = mulberry32(seedOf(seed))
  const y = h / 2
  const pts: [number, number][] = []
  /* 1px inset so the round linecap stays inside the node's measured box */
  for (let i = 0; i <= 16; i++) pts.push([1 + (i * (w - 2)) / 16, y + (rand() - 0.5) * 5])
  return smoothPath(pts)
}

/* arrowhead chevron aligned to the ACTUAL arrival direction — (bx,by) is the
   unit vector pointing back along the curve from its tip */
function headAt(x1: number, y1: number, bx: number, by: number): string {
  const rot = (a: number) => [bx * Math.cos(a) - by * Math.sin(a), bx * Math.sin(a) + by * Math.cos(a)]
  const [u1x, u1y] = rot(0.45)
  const [u2x, u2y] = rot(-0.45)
  return `M ${x1} ${y1} l ${(u1x * 8.5).toFixed(1)} ${(u1y * 8.5).toFixed(1)}` +
         ` M ${x1} ${y1} l ${(u2x * 8.5).toFixed(1)} ${(u2y * 8.5).toFixed(1)}`
}
const unit = (vx: number, vy: number): [number, number] => {
  const l = Math.hypot(vx, vy) || 1
  return [vx / l, vy / l]
}
/* one hand-drawn loop pass around a card (rough.js recipe: jitter every
   sample, overshoot the close — a real pen does). The base shape is a
   SUPERellipse (n≈6), not an ellipse: a true ellipse must cut across a wide
   card's corners/title, while a squircle hugs around them. */
function roughLoop(cx: number, cy: number, rx: number, ry: number, seed: number): string {
  const rand = mulberry32(seed)
  const J = 3, n = 18, e = 0.45 /* lower = boxier squircle; 0.45 keeps the pen
                                   loop clear of the corners but reads rounder */
  const start = -Math.PI / 2 + (rand() - 0.5) * 0.6
  const pts: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const a = start + (i / n) * (Math.PI * 2 + 0.28)
    const c = Math.cos(a), s = Math.sin(a)
    pts.push([
      cx + Math.sign(c) * Math.abs(c) ** e * rx + (rand() - 0.5) * 2 * J,
      cy + Math.sign(s) * Math.abs(s) ** e * ry + (rand() - 0.5) * 2 * J,
    ])
  }
  return smoothPath(pts)
}
/* sample the margin arrow's cubic and push points along the normal by a
   damped sine → the squiggly doodle arrow (tip lands clean). Returns the
   path plus the true back-direction at the tip for the arrowhead. */
function squiggleCurve(
  x0: number, y0: number, c1x: number, c1y: number,
  c2x: number, c2y: number, x1: number, y1: number,
): { d: string; back: [number, number] } {
  const B = (t: number, a: number, b: number, c: number, d: number) =>
    (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d
  const D = (t: number, a: number, b: number, c: number, d: number) =>
    3 * (1 - t) ** 2 * (b - a) + 6 * (1 - t) * t * (c - b) + 3 * t * t * (d - c)
  /* ONE gentle wave, scaled to the runway — more cycles reads as a scribbled
     knot; the doodle-arrow look is a soft S, not a sine train */
  const chord = Math.hypot(x1 - x0, y1 - y0)
  const cycles = Math.min(1.6, Math.max(1, chord / 70))
  const amp = Math.min(5, Math.max(3, chord / 22))
  const pts: [number, number][] = []
  const N = 16
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const x = B(t, x0, c1x, c2x, x1), y = B(t, y0, c1y, c2y, y1)
    const dx = D(t, x0, c1x, c2x, x1), dy = D(t, y0, c1y, c2y, y1)
    const len = Math.hypot(dx, dy) || 1
    const off = Math.sin(t * Math.PI * 2 * cycles) * amp * (1 - t * 0.7)
    pts.push([x + (-dy / len) * off, y + (dx / len) * off])
  }
  const [px, py] = pts[N - 1]
  return { d: smoothPath(pts), back: unit(px - x1, py - y1) }
}

/* ════════════════════════════════════════════════════════════════
   DOM HELPERS
   ════════════════════════════════════════════════════════════════ */
const SVG_NS = 'http://www.w3.org/2000/svg'
function svgEl(cls: string, tone: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg')
  s.setAttribute('class', cls)
  s.style.setProperty('--t', tone)
  return s
}
function divEl(cls: string, tone: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  d.style.setProperty('--t', tone)
  return d
}
/* Note text renders through DOM nodes, never innerHTML — annotation copy is
   system-authored today, but the triage engine will eventually interpolate
   user-derived strings (titles, names), so treat it as untrusted. Two markers
   become elements, everything else is a plain text node:
     `<b>…</b>`         → bold in the annotation's own tone
     `<a>…</a>`         → a link to the annotation's OWN `href` (the marker never
                          carries the URL — the caller does, and it's rejected
                          unless it's a same-origin absolute path), so a note can
                          end in a clickable call to action.
     `<c:TONE>…</c>`    → bold in TONE's colour (TONE ∈ AN_TONE), so a trend can
                          paint its two numbers by mastery band (green→red). The
                          tone is matched against the fixed enum, and the colour
                          comes from AN_TONE — never from the text — so this stays
                          XSS-safe (textContent only, no interpolated markup). */
/** Same-origin app paths only — `/x`, never `//host`, `javascript:` or an
 *  absolute URL. The href is caller-supplied, so this is the gate that keeps a
 *  rendered annotation from becoming a navigation primitive. */

/* Exported for the marker/href-gate unit tests (roadmap-annotation-richtext) —
   the layer itself is only ever called from AnnotationLayer below. */
export function setRichText(el: HTMLElement, text: string, href?: string): void {
  el.textContent = ''
  const link = safeAppPath(href)
  const re = /<b>(.*?)<\/b>|<a>(.*?)<\/a>|<c:(alert|warn|ok|info|slate)>(.*?)<\/c>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)))
    if (m[2] !== undefined) {
      // No href (or a rejected one) → render the words, just not as a link.
      if (!link) { el.appendChild(document.createTextNode(m[2])); last = re.lastIndex; continue }
      const a = document.createElement('a')
      a.className = 'lnk'
      a.href = link
      /* A link back to THIS page (S19's "study it with Athena", which only flips
         `?athena-topic=`) is a state change, not a navigation: _blank would open a
         second copy of the roadmap the reader is looking at, and the ↗ would be a
         lie. Same-page links stay in place; genuinely cross-page ones keep both. */
      const samePage = new URL(link, window.location.origin).pathname === window.location.pathname
      if (!samePage) {
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
      }
      a.textContent = samePage ? m[2] : `${m[2]} ↗`
      a.addEventListener('click', (e) => {
        e.stopPropagation() // don't pan the canvas
        if (samePage && applySamePageLink(link)) e.preventDefault()
      })
      el.appendChild(a)
      last = re.lastIndex
      continue
    }
    const b = document.createElement('b')
    if (m[1] !== undefined) {
      b.textContent = m[1]
    } else {
      // Toned span: give it its OWN --t so the highlighter swipe (which reads
      // var(--t)) tints to a light shade of this tone, and darken the text with
      // ink rather than using the raw (light) tone colour.
      // The 50% mix is measured, not taste: these run at 12px/700 over their own
      // tinted swipe, where AA needs 4.5:1. A 72% mix gave 2.8–3.1:1 (worse than
      // the single-tone version it replaced); 50% lands at 4.7–4.9:1 and the
      // green/amber/red are still plainly distinguishable. Tone is redundant
      // reinforcement here — the numbers, the arrow and the words each carry the
      // direction on their own — but redundant still has to be legible.
      const c = AN_TONE[m[3] as EmphasisTone]
      b.textContent = m[4]
      b.style.setProperty('--t', c)
      b.style.color = `color-mix(in oklab, ${c} 50%, var(--ink))`
    }
    el.appendChild(b)
    last = re.lastIndex
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)))
}

/* ════════════════════════════════════════════════════════════════
   NODE RESOLUTION — flow nodes → titles → rects (flow coordinates)
   ════════════════════════════════════════════════════════════════ */
interface Rect { left: number; top: number; width: number; height: number }
interface Target { node: Node; rect: Rect; side: 'L' | 'R' | 'C'; group: 'res' | 'sess' | 'mod' }

type FlowData = {
  r?: Resource
  note?: Resource
  s?: Session
  room?: Session
  m?: CourseModule
  side?: 'L' | 'R'
}

function targetsOf(nodes: Node[]): Target[] {
  const out: Target[] = []
  for (const n of nodes) {
    if (n.type === 'spine') continue
    const h = n.measured?.height
    const w = n.measured?.width ?? (typeof (n.style as CSSProperties | undefined)?.width === 'number'
      ? ((n.style as CSSProperties).width as number) : undefined)
    if (h == null || w == null) continue /* not measured yet — next pass positions it */
    const d = n.data as FlowData
    const group: Target['group'] = n.type === 'module' ? 'mod' : n.type === 'session' || n.type === 'live' ? 'sess' : 'res'
    out.push({
      node: n,
      rect: { left: n.position.x, top: n.position.y, width: w, height: h },
      side: d.side ?? 'C',
      group,
    })
  }
  return out
}
function titleOf(t: Target): string {
  const d = t.node.data as FlowData
  return d.r?.t ?? d.note?.t ?? d.s?.t ?? d.room?.t ?? d.m?.title ?? ''
}
/** The card's node key (`module_item:{id}`) — what an `item:` target matches. */
function keyOf(t: Target): string | undefined {
  return (t.node.data as FlowData).r?.key
}
/* The prefixes, and the exact-before-substring rule, live in annotation-target.ts
   — shared with the triage engine's own locator, which used to be a second copy
   of these rules and was free to disagree about which card a target meant. */
function resolve(targets: Target[], sub: string): Target | null {
  return resolveTarget(targets, sub, { group: (t) => t.group, title: titleOf, key: keyOf }) ?? null
}
/* rule annotations anchor to the MODULE row only — a session or lecture that
   shares the module's title must not pull the scope line down into the band */
function resolveFor(targets: Target[], a: RoadmapAnnotation): Target | null {
  if (a.v === 'rule') return targets.find((t) => t.group === 'mod' && titleOf(t).includes(a.t)) ?? null
  return resolve(targets, a.t)
}
const overlaps = (a: Rect, b: Rect) =>
  a.left < b.left + b.width && a.left + a.width > b.left &&
  a.top < b.top + b.height && a.top + a.height > b.top
/* how much two boxes intersect, in px² — 0 when clear */
const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))
/* Where to hang a margin note beside its node so it clears both the other nodes
   AND the notes already placed this pass. Tries both lanes at each of a few
   vertical nudges, nearest first; measured with the note's REAL size. When a
   crowded map has nothing clear, falls back to the LEAST-overlapping slot tried
   rather than an arbitrary one, so the note still shows and grazes as little as
   possible. */
const NOTE_GAP = 22
/* How far a roof flag's mast continues below the card's top edge, hidden behind
   the card — the difference between a flag planted in the node and one hovering
   above it on a floating stub. */
const MAST_TUCK = 20

/**
 * How far past a card's edge an annotation can reach: the gap plus the widest
 * annotation body (`.an-margin.big` / `.an-xref` / `.an-tally` are 150px in
 * roadmap-prototype.css).
 *
 * Exported because the canvas has to know it to frame the map. The default view
 * centres the spine at zoom 1, which fits the CARD columns — annotations live
 * outside them, so on a 1440px laptop the right-hand lane fell off the viewport
 * and most of the triage output was unreadable without turning on Pan & zoom.
 */
export const ANNOTATION_REACH = NOTE_GAP + 150
function freeSlot(
  nr: Rect, w: number, h: number, preferL: boolean, canFlip: boolean, obstacles: Rect[],
): { L: boolean; top: number } {
  const baseTop = nr.top + nr.height / 2 - h / 2 + 8
  const leftOf = (L: boolean) => (L ? nr.left - w - NOTE_GAP : nr.left + nr.width + NOTE_GAP)
  const sides = canFlip ? (preferL ? [true, false] : [false, true]) : [preferL]
  // Nudge is the OUTER loop: try both lanes *level with the node* before displacing
  // vertically at all. Sides-outer meant a note exhausted every vertical offset on
  // its preferred side before testing an empty lane two inches away — so it would
  // rather sit 190px up, inside the neighbouring module band (MOD_GAP is 44px), than
  // switch sides. Gestalt proximity beats a 2px pen line: a note next to the wrong
  // card reads as belonging to it, arrow or no arrow.
  // The ladder still runs out to ±192 as a last resort. Measured on the demo course,
  // capping it at ±96 traded the deep-but-clear slots for an actual note-over-card
  // overlap — being far is a weaker association, being on top of a card is a defect.
  const nudges = [0, -48, 48, -96, 96, -144, 144, -192, 192]
  let best: { L: boolean; top: number; bad: number } | null = null
  for (const dy of nudges) {
    for (const L of sides) {
      const box: Rect = { left: leftOf(L), top: baseTop + dy, width: w, height: h }
      const bad = obstacles.reduce((s, o) => s + overlapArea(box, o), 0)
      if (bad === 0) return { L, top: box.top }
      if (!best || bad < best.bad) best = { L, top: box.top, bad }
    }
  }
  return best ? { L: best.L, top: best.top } : { L: preferL, top: baseTop }
}

/* ════════════════════════════════════════════════════════════════
   THE LAYER — build (per annotation list) + draw (per nodes pass)
   + arm-on-approach + the xref flash ring. Rendered inside
   <ReactFlow> via ViewportPortal, so it lives in flow coordinates.
   ════════════════════════════════════════════════════════════════ */
/* every per-annotation SVG spans this fixed canvas box (flow coords), so path
   data can use flow coordinates directly */
const BOX_X = -1200, BOX_W = 2400, BOX_PAD_Y = 100
function setBox(svg: SVGSVGElement, height: number): void {
  svg.style.left = `${BOX_X}px`
  svg.style.top = `${-BOX_PAD_Y}px`
  svg.style.width = `${BOX_W}px`
  svg.style.height = `${height + 2 * BOX_PAD_Y}px`
  svg.setAttribute('viewBox', `${BOX_X} ${-BOX_PAD_Y} ${BOX_W} ${height + 2 * BOX_PAD_Y}`)
}
/* the "you were sent here" cue: a pen ring flashes once around the linked
   node, then fades */
function flashRing(layer: HTMLElement, rect: Rect, tone: string, height: number): void {
  const svg = svgEl('an an-ring flash', tone)
  setBox(svg, height)
  const p = document.createElementNS(SVG_NS, 'path')
  p.setAttribute('pathLength', '1')
  p.setAttribute('d', roughLoop(rect.left + rect.width / 2, rect.top + rect.height / 2,
    rect.width / 2 + 26, rect.height / 2 + 16, seedOf(tone) + 3))
  svg.appendChild(p)
  layer.appendChild(svg)
  setTimeout(() => svg.remove(), 3000)
}

interface Rec {
  a: RoadmapAnnotation
  els: Record<string, HTMLElement | SVGSVGElement>
  armed: boolean
  /* xref: the linked node's geometry, refreshed each draw pass */
  link?: { cx: number; cy: number; rect: Rect }
}

export function AnnotationLayer({ nodes, annotations, height }: {
  nodes: Node[]
  annotations: RoadmapAnnotation[]
  height: number
}) {
  const rf = useReactFlow()
  const halosRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<HTMLDivElement>(null)
  const recsRef = useRef<Rec[]>([])
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  /* the xref click handler outlives any single draw pass — it reads the
     current canvas height through this ref (kept fresh by the draw effect) */
  const heightRef = useRef(height)

  /* ── BUILD: annotation DOM, one rec per entry (audience flips rebuild) ── */
  useEffect(() => {
    const halos = halosRef.current, notesL = notesRef.current
    if (!halos || !notesL) return
    halos.textContent = ''
    notesL.textContent = ''
    recsRef.current = annotations.map((a) => {
      const tone = AN_TONE[a.tone]
      const els: Rec['els'] = {}
      const rec: Rec = { a, els, armed: false }
      if (a.v === 'margin' || a.v === 'xref') {
        const sub = a.v === 'xref' ? '' : (a.sub ?? '')
        els.main = divEl(`an an-margin ${sub}${a.v === 'xref' ? ' an-xref' : ''}`.trim(), tone)
        setRichText(els.main, a.text ?? '', a.href)
        if (a.v === 'xref') {
          const lnk = document.createElement('span')
          lnk.className = 'lnk'
          lnk.textContent = ` ${a.t2 ?? ''} ↗`
          lnk.setAttribute('role', 'link')
          lnk.tabIndex = 0
          els.main.appendChild(lnk)
          const go = (e: Event) => {
            e.stopPropagation()
            if (!rec.link) return
            const { cx, cy, rect } = rec.link
            rf.setCenter(cx, cy, { zoom: rf.getZoom(), duration: 600 })
            setTimeout(() => { /* ring once the pan lands */
              if (notesRef.current) flashRing(notesRef.current, rect, tone, heightRef.current)
            }, 650)
          }
          els.main.addEventListener('click', go)
          lnk.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e) }
          })
        }
        els.arrow = svgEl(`an an-marrow ${a.v === 'xref' ? 'xref' : sub}`.trim(), tone)
        els.arrow.innerHTML = (sub === 'dots' || sub === 'squiggle')
          ? '<path class="curve"/><path class="head"/>'
          : '<path class="draw" pathLength="1"/><path class="tip" pathLength="1"/>'
      }
      if (a.v === 'flag') {
        if (a.sub === 'tab') { /* tucked under the card → underlayer */
          const tab = document.createElement('span')
          tab.className = 'an an-tab'
          tab.style.setProperty('--t', tone)
          tab.textContent = a.text ?? ''
          els.tab = tab
        } else {
          els.main = divEl(`an an-flag ${a.sub ?? ''}`.trim(), tone)
          const mast = document.createElement('i')
          mast.className = 'mast'
          const pen = document.createElement('span')
          pen.className = 'pen'
          setRichText(pen, a.text ?? '', a.href)
          els.main.append(mast, pen)
        }
      }
      if (a.v === 'ring') {
        els.ring = svgEl('an an-ring', tone)
        els.ring.innerHTML = '<path class="p1" pathLength="1"/><path class="p2" pathLength="1"/><path class="rarr" pathLength="1"/><path class="rtip" pathLength="1"/>'
        els.note = divEl('an an-rnote', tone)
        setRichText(els.note, a.text ?? '', a.href)
      }
      if (a.v === 'mark') {
        if (a.sub === 'bang') {
          els.mark = svgEl('an an-bang', tone)
          els.mark.setAttribute('viewBox', '0 0 20 30')
          els.mark.innerHTML = '<path d="M10.5 3.2 C 9.4 8.8, 10.6 13.6, 9.6 19"/><circle cx="9.4" cy="25.6" r="2.3"/>'
        }
        if (a.sub === 'dogear') {
          const fold = document.createElement('span')
          fold.className = 'an an-dogear'
          fold.style.setProperty('--t', tone)
          els.mark = fold
          const tag = document.createElement('span')
          tag.className = 'an an-dogtag'
          tag.style.setProperty('--t', tone)
          tag.textContent = a.text ?? ''
          els.tag = tag
        }
      }
      if (a.v === 'tally') {
        /* strokes are node-independent — generate once, seeded */
        const rand = mulberry32(seedOf(a.t))
        const jit = (r: number) => (rand() - 0.5) * 2 * r
        const count = a.n ?? 0
        let strokes = ''
        for (let i = 0; i < count; i++) {
          const g = Math.floor(i / 5) * 26, k = i % 5
          const delay = `style="animation-delay:${(0.15 + i * 0.11).toFixed(2)}s"`
          strokes += k === 4
            ? `<path pathLength="1" ${delay} d="M ${(g - 3 + jit(1.5)).toFixed(1)} ${(15 + jit(1.5)).toFixed(1)} C ${g + 5} ${10 + jit(2)}, ${g + 11} ${6 + jit(2)}, ${(g + 19 + jit(1.5)).toFixed(1)} ${(3 + jit(1.5)).toFixed(1)}"/>`
            : `<path pathLength="1" ${delay} d="M ${(g + k * 4.5 + 1 + jit(1.2)).toFixed(1)} ${(2 + jit(1.5)).toFixed(1)} C ${g + k * 4.5 + jit(1.5)} 7, ${g + k * 4.5 + 1 + jit(1.5)} 12, ${(g + k * 4.5 + jit(1.2)).toFixed(1)} ${(17 + jit(1.5)).toFixed(1)}"/>`
        }
        const gw = Math.max(26, Math.ceil(count / 5) * 26)
        els.main = divEl('an an-tally', tone)
        els.main.innerHTML = `<svg viewBox="0 0 ${gw} 19" width="${gw}" height="19">${strokes}</svg>`
        const cap = document.createElement('div')
        cap.className = 'cap'
        setRichText(cap, a.text ?? '', a.href)
        els.main.appendChild(cap)
      }
      if (a.v === 'rule') {
        els.line = svgEl('an an-rule', tone)
        els.line.innerHTML = '<path/>'
        const label = document.createElement('span')
        label.className = 'an an-rule-label'
        label.style.setProperty('--t', tone)
        label.textContent = a.text ?? ''
        els.label = label
      }
      Object.values(els).forEach((e) => e.classList.add('an-wait'))
      /* Flags live UNDER the cards: a tucked tab hides its root behind the card's
         outer edge, and a roof flag's mast is planted behind the card's top edge so
         it reads as standing IN the node rather than hovering over it. Everything
         else is a callout and floats above the map. */
      const under = a.v === 'flag'
      Object.entries(els).forEach(([, e]) => (under ? halos : notesL).appendChild(e))
      return rec
    })
    return () => {
      halos.textContent = ''
      notesL.textContent = ''
      recsRef.current = []
    }
  }, [annotations, rf])

  /* ── DRAW: resolve targets + position everything (re-runs whenever the
        layout changes: measure, expand/collapse, calm toggle) ── */
  useEffect(() => {
    heightRef.current = height
    const targets = targetsOf(nodes)
    // Margin notes claim space in priority order (the engine emits highest first),
    // each avoiding the nodes + the notes already placed, so callouts don't stack.
    const placed: Rect[] = []
    recsRef.current.forEach((rec) => {
      const { a, els } = rec
      const t = resolveFor(targets, a)
      const t2 = a.t2 ? resolve(targets, a.t2) : null
      const vis = !!t && (!a.t2 || !!t2)
      Object.values(els).forEach((e) => { e.style.display = vis ? '' : 'none' })
      if (!t || !vis) return
      const nr = t.rect
      let L = t.side === 'C' ? true : t.side === 'L'
      const nL = nr.left, nR = nr.left + nr.width, nT = nr.top
      if (t2) {
        rec.link = { cx: t2.rect.left + t2.rect.width / 2, cy: t2.rect.top + t2.rect.height / 2, rect: t2.rect }
      }

      // Every card except this one, plus the callouts already placed: what a
      // margin note (or a roof flag with no air above it) has to keep clear of.
      const obstacles = targets.filter((o) => o !== t).map((o) => o.rect).concat(placed)

      if (a.v === 'margin' || a.v === 'xref') { /* beside the node, arrow in */
        const main = els.main as HTMLElement
        const arrow = els.arrow as SVGSVGElement
        const w = main.offsetWidth, h = main.offsetHeight
        // Find a slot clear of nodes + already-placed notes; spine nodes may flip side.
        const slot = freeSlot(nr, w, h, L, t.side === 'C', obstacles)
        L = slot.L
        const mx = L ? nL - w - 22 : nR + 22
        const my = slot.top
        main.style.left = `${mx}px`
        main.style.top = `${my}px`
        // Ragged-left is fine for the 1–3 line notes this rule was written for;
        // past that (the quote-carrying slice-4 notes) the eye's return edge
        // moves every line, so a wrapped paragraph always reads left-aligned.
        main.style.textAlign = L && h <= 54 ? 'right' : 'left'
        placed.push({ left: mx, top: my, width: w, height: h })
        const s = L ? -1 : 1
        let curve: string, back: [number, number], x1: number, y1: number
        if (a.sub === 'squiggle') {
          /* longer lasso sweep — from the note's top, up and over, landing on
             the ROOF: a squiggle needs runway to read wavy */
          const sx = L ? mx + w - 12 : mx + 12, sy = my - 4
          x1 = L ? nL + 44 : nR - 44
          y1 = nT - 5
          ;({ d: curve, back } = squiggleCurve(sx, sy, sx + 24 * s, sy - 26, x1 + 30 * s, y1 - 18, x1, y1))
        } else {
          const x0 = L ? mx + w - 4 : mx + 4, y0 = my + 2
          x1 = L ? nL - 4 : nR + 4
          y1 = nT + 16
          curve = `M ${x0} ${y0} C ${x0 - 14 * s} ${y0 - 14}, ${x1 + 20 * s} ${y1 - 12}, ${x1} ${y1}`
          back = unit(20 * s, -12) /* toward the last control point */
        }
        const head = headAt(x1, y1, ...back)
        setBox(arrow, height)
        if (a.sub === 'dots' || a.sub === 'squiggle') { /* ants march the curve, head stays */
          arrow.querySelector('.curve')?.setAttribute('d', curve)
          arrow.querySelector('.head')?.setAttribute('d', head)
        } else {
          arrow.querySelector('.draw')?.setAttribute('d', curve)
          arrow.querySelector('.tip')?.setAttribute('d', head)
        }
      }

      if (a.v === 'flag') {
        if (a.sub === 'tab') { /* tucked under the outer edge */
          const tab = els.tab as HTMLElement
          tab.classList.toggle('outL', L)
          tab.classList.toggle('outR', !L)
          const w = tab.offsetWidth /* AFTER the side class — padding differs */
          tab.style.left = `${L ? nL - w + 12 : nR - 12}px`
          tab.style.top = `${nT + nr.height - 32}px`
        } else { /* planted on the roof — needs open air (lane-first nodes) */
          const main = els.main as HTMLElement
          const h = a.sub === 'banner' ? 46 : 33
          main.style.left = `${nL + 24}px`
          main.style.top = `${nT - h}px`
          /* The mast runs PAST the card's top edge and finishes behind it (the
             flag layer sits under the cards), so the pole reads as planted in the
             node instead of floating above it on a stub. */
          main.style.height = `${h + MAST_TUCK}px`
          const pen = main.querySelector<HTMLElement>('.pen')
          const penW = pen?.offsetWidth ?? 80
          /* What must stay clear is the PENNANT, not the whole mast: the mast is a
             2px line, and the layout reserves FLAG_AIR above a flagged card for
             exactly this box. Measuring the full element height instead made the
             roof read as blocked on knife-edge gaps and threw the flag into the
             margin. */
          const box: Rect = { left: nL + 24, top: nT - h, width: penW + 4, height: (pen?.offsetHeight ?? 22) + 4 }
          /* A roof flag must never lie across another card, and in a stacked lane
             (12px gaps) there is no air above at all. It used to hide itself —
             which silently deleted the loudest signals on the map ("5 never started
             it", "closes tonight") on exactly the nodes that stack. So plant it in
             the open margin beside the card instead, mast up, pennant pointing back
             at it; only give up if even that has nowhere clear to stand.

             Tested against `obstacles`, not just the cards: flags draw UNDER the
             cards (z 1) while margin notes float above them (z 6), so a note that
             already claimed a slot inside this card's reserved air would silently
             paint over the flag — a worse failure than the one the fallback fixes,
             because the code would believe it had succeeded. */
          if (obstacles.some((o) => overlaps(box, o))) {
            const w = penW + 6
            const slot = freeSlot(nr, w, h, L, t.side === 'C', obstacles)
            const fx = slot.L ? nL - w - NOTE_GAP : nR + NOTE_GAP
            const marginBox: Rect = { left: fx, top: slot.top, width: w, height: h }
            if (obstacles.some((o) => overlaps(marginBox, o))) {
              Object.values(els).forEach((e) => { e.style.display = 'none' })
            } else {
              main.style.left = `${fx}px`
              main.style.top = `${slot.top}px`
              main.style.height = `${h}px` /* nothing to tuck into out here */
              placed.push(marginBox)
            }
          } else {
            // the whole mast, not just the pennant — a later note must not be
            // offered the strip of air the pole occupies
            placed.push({ ...box, height: h + MAST_TUCK })
          }
        }
      }

      if (a.v === 'ring') { /* pen loop around the node */
        const ring = els.ring as SVGSVGElement
        const note = els.note as HTMLElement
        const seed = seedOf(a.t), s = L ? -1 : 1
        const cx = (nL + nR) / 2, cy = nT + nr.height / 2
        /* pads sized so the squircle clears the card's corners (± jitter) */
        const rx = nr.width / 2 + 26, ry = nr.height / 2 + 16
        setBox(ring, height)
        ring.querySelector('.p1')?.setAttribute('d', roughLoop(cx, cy, rx, ry, seed))
        ring.querySelector('.p2')?.setAttribute('d', roughLoop(cx, cy, rx, ry, seed + 7))
        /* the same pen adds a note + arrow pointing at the loop's shoulder
           (.915/.863 = the squircle at ~40°) */
        const w = note.offsetWidth, h = note.offsetHeight
        const ex = cx + s * rx * 0.915, ey = cy - ry * 0.863
        const mx = cx + s * (rx + 24) + (L ? -w : 0)
        const my = ey - h - 26
        note.style.left = `${mx}px`
        note.style.top = `${my}px`
        note.style.textAlign = L ? 'right' : 'left'
        // Not slot-searched — this note is pinned to the loop's shoulder so its
        // arrow lands right — but it still claims space, so margin notes and
        // tallies placed after it must route around it.
        placed.push({ left: mx, top: my, width: w, height: h })
        const x0 = mx + (L ? w - 10 : 10), y0 = my + h + 3
        ring.querySelector('.rarr')?.setAttribute('d',
          `M ${x0} ${y0} C ${x0 + 10 * s} ${y0 + 14}, ${ex + 18 * s} ${ey - 16}, ${ex} ${ey}`)
        ring.querySelector('.rtip')?.setAttribute('d', headAt(ex, ey, ...unit(18 * s, -16)))
      }

      if (a.v === 'mark') { /* pinned to the outer top corner */
        const mark = els.mark as HTMLElement
        if (a.sub === 'dogear') {
          mark.classList.toggle('dgL', L)
          mark.classList.toggle('dgR', !L)
          mark.style.left = `${L ? nL + 1.5 : nR - 18.5}px`
          mark.style.top = `${nT + 1.5}px`
          const tag = els.tag as HTMLElement
          const w = tag.offsetWidth /* sticker beside the fold */
          tag.style.left = `${L ? nL + 21 : nR - 21 - w}px`
          tag.style.top = `${nT - 9}px` /* straddles the top edge */
        } else if (a.sub === 'bang') {
          /* anchored ON the top-left corner (mostly over the card, white
             knockout keeps it legible) — floating in the lane gap read as
             belonging to either neighbor */
          mark.style.left = `${nL + 5}px`
          mark.style.top = `${nT - 14}px`
        }
      }

      if (a.v === 'tally') { /* margin-style data note — same lane as a margin note */
        const main = els.main as HTMLElement
        const w = main.offsetWidth, h = main.offsetHeight
        // Tallies share the margin lane, so they need the same slot search and must
        // register in `placed` — otherwise they stack on each other and on margin
        // notes. Most engagement signals (open counts, click-throughs) are tallies.
        const obstacles = targets.filter((o) => o !== t).map((o) => o.rect).concat(placed)
        const slot = freeSlot(nr, w, h, L, t.side === 'C', obstacles)
        L = slot.L
        const tx = L ? nL - w - 22 : nR + 22
        main.style.left = `${tx}px`
        main.style.top = `${slot.top}px`
        main.style.textAlign = L ? 'right' : 'left'
        placed.push({ left: tx, top: slot.top, width: w, height: h })
        const svg = main.querySelector('svg')
        if (svg) svg.style.marginLeft = L ? 'auto' : '0'
      }

      if (a.v === 'rule') { /* map-wide scope boundary above the module */
        const line = els.line as SVGSVGElement
        const label = els.label as HTMLElement
        const rand = mulberry32(seedOf(a.text ?? a.t))
        /* the line must not lie across any card: side lanes often run taller
           than their module card, so "module top − 24" can land inside the
           previous band. Place it in the CLEAR STRIP between everything that
           belongs above the boundary (module indices < k) and everything at
           or below it — the semantic split the rule expresses anyway. */
        const k = Number(/^m(\d+)/.exec(t.node.id)?.[1] ?? NaN)
        let above = -Infinity, below = Infinity
        for (const o of targets) {
          const i = Number(/^m(\d+)/.exec(o.node.id)?.[1] ?? NaN)
          if (Number.isNaN(i) || Number.isNaN(k)) continue
          if (i < k) above = Math.max(above, o.rect.top + o.rect.height)
          else below = Math.min(below, o.rect.top)
        }
        const y = Number.isFinite(above) && Number.isFinite(below) && above < below
          ? (above + below) / 2
          : nT - 24 /* first module / interleaved bands: the roof fallback */
        const xs = targets.map((o) => o.rect.left)
        const xe = targets.map((o) => o.rect.left + o.rect.width)
        const x0 = Math.min(...xs) - 40, x1 = Math.max(...xe) + 40
        const pts: [number, number][] = []
        for (let i = 0; i <= 16; i++) pts.push([x0 + (i * (x1 - x0)) / 16, y + (rand() - 0.5) * 5])
        setBox(line, height)
        line.querySelector('path')?.setAttribute('d', smoothPath(pts))
        const w = label.offsetWidth
        label.style.left = `${(x0 + x1 - w) / 2}px`
        label.style.top = `${y - 10}px`
      }
    })

    /* ── ARM: play each annotation's one-shot animations 450ms after its
          node scrolls into view (nodes already on screen play right away) ── */
    const flowRoot = notesRef.current?.closest('.react-flow')
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        const recs = recsRef.current.filter((r) =>
          !r.armed && resolveFor(targets, r.a)?.node.id === entry.target.getAttribute('data-id'))
        timersRef.current.push(setTimeout(() => {
          recs.forEach((r) => {
            r.armed = true
            Object.values(r.els).forEach((e) => e.classList.remove('an-wait'))
          })
        }, ARM_HOLD_MS))
        io.unobserve(entry.target)
      })
    }, ARM_IO)
    const seen = new Set<string>()
    recsRef.current.forEach((rec) => {
      if (rec.armed) return
      const id = resolveFor(targets, rec.a)?.node.id
      if (!id || seen.has(id)) return
      seen.add(id)
      const el = flowRoot?.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
      if (el) io.observe(el)
    })
    const timers = timersRef.current
    return () => {
      io.disconnect()
      timers.forEach(clearTimeout)
      timers.length = 0
    }
  }, [nodes, annotations, height])

  return (
    <ViewportPortal>
      {/* tucked tabs live UNDER the cards (node wrappers sit at z 3–5) */}
      <div className="anlayer" ref={halosRef} style={{ zIndex: 1 }} />
      {/* callouts float above the map */}
      <div className="anlayer" ref={notesRef} style={{ zIndex: 6 }} />
    </ViewportPortal>
  )
}

/* ════════════════════════════════════════════════════════════════
   DEMO EMPHASIS — applies the demo spec onto course data by title
   (the real pipeline will set em/emTone in the adapter instead).
   ════════════════════════════════════════════════════════════════ */
export function applyDemoEmphasis(course: CourseModule[], spec: readonly EmphasisSpec[]): CourseModule[] {
  const mods = course.map((m) => ({
    ...m,
    materials: m.materials.map((r) => ({ ...r })),
    quizzes: m.quizzes.map((r) => ({ ...r })),
    assignments: m.assignments.map((r) => ({ ...r })),
    sessions: m.sessions?.map((s) => ({ ...s })),
    liveRoom: m.liveRoom ? { ...m.liveRoom } : undefined,
  }))
  for (const e of spec) {
    let hit: { em?: EmphasisKind; emTone?: EmphasisTone } | undefined
    for (const m of mods) {
      hit = [...m.materials, ...m.quizzes, ...m.assignments].find((r) => r.t.includes(e.t))
      if (hit) break
    }
    if (!hit) {
      for (const m of mods) {
        hit = m.sessions?.find((s) => s.t.includes(e.t)) ?? (m.liveRoom?.t.includes(e.t) ? m.liveRoom : undefined)
        if (hit) break
      }
    }
    if (!hit) hit = mods.find((m) => m.title.includes(e.t))
    if (hit) { hit.em = e.em; hit.emTone = e.tone }
  }
  return mods
}

/* ════════════════════════════════════════════════════════════════
   DEMO DATA — stands in for the triage engine's output. Same nodes,
   opposite framings: professor = aggregate + action · student =
   self + next step. Deliberately dense (a real engine would rank and
   restrict). Entries tagged C-, PF- or U-numbers map to the
   athena-students use-case catalog.
   ════════════════════════════════════════════════════════════════ */
export const DEMO_ANNOTATIONS: Record<'prof' | 'stu', RoadmapAnnotation[]> = {
  prof: [
    /* what the class did */
    { v: 'margin', tone: 'slate', t: 'Bengio et al.', text: 'no one has opened this one yet' },
    { v: 'margin', tone: 'slate', t: 'Syllabus — CS584', text: 'students keep re-downloading this — pin it?' },
    { v: 'margin', sub: 'ink', tone: 'alert', t: 'Vaswani et al.', text: '40% stalled here — your notes give it <b>2 pages</b>. supplement?' }, /* PF2 teaching gap */
    { v: 'margin', sub: 'ink', tone: 'alert', t: 'Lecture 2: Language Modeling', text: 'mastery slipping — <b>64% → 52%</b>' },
    { v: 'margin', sub: 'ink', tone: 'info', t: 'Understanding LSTM Networks', text: '<b>9 students</b> clicked through — link more like this?' },
    { v: 'margin', sub: 'ink', tone: 'alert', t: 'Transformers Quiz 1', text: '<b>Q5</b> discriminates poorly — its source page is ambiguous' }, /* PF4 item quality */
    { v: 'margin', sub: 'big', tone: 'alert', t: 'Lecture 3: Word Vectors', text: '<b>11 of 24</b> stuck here' },
    { v: 'tally', tone: 'alert', t: 'Midterm — Sample Exam', n: 13, text: '13 opened this week — midterm nerves' },
    { v: 'tally', tone: 'warn', t: 'Essay: From RNNs to Transformers', n: 8, text: '8 drafts unsubmitted' },
    { v: 'flag', sub: 'tab', tone: 'ok', t: 'Notebook: Build a Bigram LM', text: 'all graded ✓' },
    { v: 'flag', sub: 'tab', tone: 'ok', t: 't-SNE map', text: 'class favorite' },
    /* what needs the professor NOW */
    { v: 'margin', sub: 'big', tone: 'warn', t: 'Adaptive Diagnostic — NLP', text: '<b>9</b> waiting on you' },
    { v: 'margin', sub: 'dots', tone: 'warn', t: 'Intro to NLP — AI Quiz', text: '6 awaiting your grade' },
    { v: 'flag', sub: 'banner', tone: 'alert', t: 'A1: Text Classification', text: '5 missing' },
    /* NB: roof flags need open air — only lane-first nodes */
    { v: 'margin', sub: 'dots', tone: 'warn', t: 'Reading Response', text: 'closes friday — nudge the class?' },
    { v: 'flag', sub: 'wave', tone: 'warn', t: 'Midterm Review (Mixed Bank)', text: 'closes tonight' },
    { v: 'ring', tone: 'warn', t: 'Pop Quiz — RNNs', text: 'still a draft — publish it?' },
    { v: 'mark', sub: 'bang', tone: 'warn', t: '(untitled)' },
    /* what's coming — the system plans ahead with the professor */
    { v: 'flag', tone: 'info', t: 'Lecture 7: Pretraining and Post-training', text: 'up next week' },
    { v: 'margin', sub: 'dots', tone: 'info', t: 'Transformers Deep Dive', text: 'office-hour bookings spiked — add a review session?' }, /* PF6 demand sensing */
    { v: 'margin', tone: 'slate', t: 'session:Lecture 2: Language Modeling', text: 'you promised an extension here [00:41] — draft the announcement?' }, /* PF3 transcript memory */
    { v: 'ring', tone: 'info', t: 'Lecture 5: Seq2Seq and Attention', text: 'Thursday’s lecture — slides ready?' },
    { v: 'margin', sub: 'dots', tone: 'info', t: 'Let’s build GPT', text: 'assign this before Lecture 7?' },
    { v: 'margin', sub: 'squiggle', tone: 'info', t: 'Ouyang et al.', text: 'pair this with Thursday’s RLHF lecture?' },
    { v: 'margin', sub: 'squiggle', tone: 'warn', t: 'Week 8 Quiz', text: 'a draft since June — finish or drop?' },
    { v: 'mark', sub: 'dogear', tone: 'info', t: 'Wei et al.', text: 'for week 10' },
    { v: 'mark', sub: 'dogear', tone: 'slate', t: 'Jurafsky & Martin', text: 'bookmarked' },
    /* how things connect */
    { v: 'xref', tone: 'info', t: 'Oral Exam: Explain Attention', t2: 'Transformers Quiz 1', text: 'pass this first —' },
    { v: 'xref', tone: 'info', t: 'Bahdanau et al.', t2: 'Sutskever et al.', text: 'reads better after' },
    { v: 'rule', tone: 'slate', t: 'Recurrent Neural Networks', text: 'midterm scope ends here' },
  ],
  stu: [
    /* where you are, what you did */
    { v: 'ring', tone: 'info', t: 'Lecture 4: RNNs and Beyond', text: 'you are here' },
    { v: 'margin', sub: 'big', tone: 'ok', t: 'Lecture 2: Language Modeling', text: '<b>82%</b> mastered — keep going' },
    { v: 'margin', sub: 'ink', tone: 'ok', t: 'Adaptive Diagnostic — NLP', text: 'your mastery <b>35% → 78%</b>' },
    { v: 'tally', tone: 'ok', t: 'Intro to backpropagation', n: 3, text: '3 of 4 videos watched' },
    { v: 'flag', tone: 'ok', t: 'Intro to NLP — AI Quiz', text: 'grade posted ✓' },
    { v: 'margin', sub: 'dots', tone: 'info', t: 'Intro & Word Vectors', text: 'finish the last 20 minutes' },
    { v: 'margin', sub: 'ink', tone: 'info', t: 'Intro to NLP — AI Quiz', text: 'slow <b>and</b> wrong on regularization — comprehension, not carelessness' }, /* C7 attempt telemetry */
    /* what to do next */
    { v: 'margin', sub: 'big', tone: 'info', t: 'Lecture 3: Word Vectors', text: 'start <b>here</b> next' },
    { v: 'flag', sub: 'wave', tone: 'warn', t: 'A1: Text Classification', text: 'due tomorrow' },
    { v: 'margin', sub: 'dots', tone: 'warn', t: 'A1: Text Classification', text: '2 parts left — about 40 minutes' },
    { v: 'margin', sub: 'squiggle', tone: 'warn', t: 'Reading Response', text: 'due Friday — a good tonight task' },
    { v: 'margin', tone: 'slate', t: 'Course Project Guidelines', text: 'week 8 — alumni say the dataset is the crunch; start cleaning early' }, /* C12 alumni wisdom */
    { v: 'flag', sub: 'banner', tone: 'warn', t: 'Transformers Quiz 1', text: 'due Thursday' },
    { v: 'margin', sub: 'ink', tone: 'warn', t: 'Transformers Quiz 1', text: 'covers <b>Self-Attention</b> — you’re at 48%' }, /* C1 deadline triage */
    { v: 'margin', sub: 'ink', tone: 'warn', t: 'Midterm — Sample Exam', text: 'midterm in <b>9 days</b> — this is the blueprint' },
    { v: 'tally', tone: 'warn', t: 'Midterm Review (Mixed Bank)', n: 7, text: '7 weak skills to review' },
    { v: 'margin', sub: 'dots', tone: 'info', t: 'Transformers Deep Dive', text: '20-minute prep: primer + pages 12–18' }, /* C5 pre-class brief */
    { v: 'margin', sub: 'dots', tone: 'warn', t: 'Oral Exam: Explain Attention', text: 'two tries, no movement — book Thursday office hours?' }, /* C10/U17 escalation */
    { v: 'mark', sub: 'bang', tone: 'warn', t: 'Essay: From RNNs to Transformers' },
    /* how to get unstuck — the system tutors */
    { v: 'margin', sub: 'ink', tone: 'warn', t: 'The Illustrated Transformer', text: 'if the paper feels dense, start <b>here</b>' },
    { v: 'margin', sub: 'ink', tone: 'info', t: 'But what is a neural network', text: 'shaky on backprop? this rebuilds it in <b>19 min</b>' },
    { v: 'margin', sub: 'squiggle', tone: 'ok', t: 't-SNE map', text: 'fun 2-minute detour' },
    { v: 'margin', sub: 'big', tone: 'warn', t: 'Lecture 7', text: '<b>88 pages</b> — start early' },
    { v: 'margin', sub: 'ink', tone: 'info', t: 'Understanding LSTM Networks', text: 'your misses cluster on <b>gate ordering</b> — this untangles it' }, /* C2 misconception → resource */
    { v: 'margin', sub: 'ink', tone: 'warn', t: 'session:Lecture 5: Seq2Seq and Attention', text: 'you missed this one — both your weakest topics were taught here' }, /* C3 absence gap */
    { v: 'xref', tone: 'info', t: 'Lecture 6: Transformers', t2: 'Lecture 5: Seq2Seq and Attention', text: 'stuck? the prereq is at <b>40%</b> — start one node back:' }, /* C4 prereq chain + U18 */
    { v: 'xref', tone: 'info', t: 'Notebook: Build a Bigram LM', t2: 'Lecture 2: Language Modeling', text: 'uses perplexity from' },
    /* for later */
    { v: 'margin', tone: 'slate', t: 'Mikolov et al.', text: 'optional — skim if curious' },
    { v: 'flag', sub: 'tab', tone: 'info', t: 'The Illustrated Word2vec', text: 'recommended' },
    { v: 'flag', sub: 'tab', tone: 'info', t: 'Bahdanau et al.', text: 'core reading' },
    { v: 'flag', sub: 'tab', tone: 'ok', t: 'Notes: Logistic Regression', text: 'challenge #3 · 50 pts' }, /* C14 matchmaking */
    { v: 'mark', sub: 'dogear', tone: 'info', t: 'Jurafsky & Martin', text: 'saved for later' },
    { v: 'mark', sub: 'dogear', tone: 'info', t: 'Yao et al.', text: 'weekend read' },
    { v: 'mark', sub: 'dogear', tone: 'info', t: 'Lecture 8: More Post-training', text: 'new since monday' }, /* C15 catch-up */
    { v: 'rule', tone: 'slate', t: 'Recurrent Neural Networks', text: 'everything above is on the midterm' },
  ],
}

export const DEMO_EMPHASIS: Record<'prof' | 'stu', EmphasisSpec[]> = {
  prof: [
    { em: 'shine', tone: 'info', t: 'Lecture 1: Introduction to NLP' },
    { em: 'breathe', tone: 'alert', t: 'A1: Text Classification' },
    { em: 'breathe', tone: 'warn', t: 'Week 8 Quiz' },
    { em: 'outline', tone: 'info', t: 'Notes: word2vec' },
    { em: 'outline', tone: 'info', t: 'Lecture 9: Reasoning and Agents' },
    { em: 'wash', tone: 'ok', t: 'Transformers Quiz 1' },
    { em: 'wash', tone: 'ok', t: 'Guest Lecture — Scaling Laws' },
    { em: 'wiggle', tone: 'warn', t: '(untitled)' },
    { em: 'tada', tone: 'ok', t: 'Grade Weights Calculator' },
    { em: 'tada', tone: 'ok', t: 'Notebook: Build a Bigram LM' },
  ],
  stu: [
    { em: 'shine', tone: 'info', t: 'Lecture 3: Word Vectors' },
    { em: 'breathe', tone: 'warn', t: 'A1: Text Classification' },
    { em: 'breathe', tone: 'warn', t: 'Transformers Quiz 1' },
    { em: 'outline', tone: 'info', t: 'Lecture 5: Seq2Seq and Attention' },
    { em: 'outline', tone: 'info', t: 'Lecture 1: Introduction to NLP' },
    { em: 'wash', tone: 'ok', t: 'Intro to NLP — AI Quiz' },
    { em: 'tada', tone: 'ok', t: 'Adaptive Diagnostic — NLP' },
    { em: 'wiggle', tone: 'warn', t: 'Essay: From RNNs to Transformers' },
    { em: 'wiggle', tone: 'warn', t: 'Midterm — Sample Exam' },
  ],
}
