/**
 * Athena → Document rich-block builder.
 *
 * Turns a (blockType, JSON config) pair from Athena's `insertBlock` op into a validated
 * ProseMirror node JSON that the editor inserts directly via insertContent — bypassing
 * HTML parsing, so the block lands with PROPER configuration every time. Each block's
 * config is validated against its real node schema (lenient: defaults fill the gaps);
 * an unusable config returns null so the adapter skips it (never a broken block, never a
 * false "inserted").
 *
 * Pure + client-safe (zod only) → unit-testable. Config shapes mirror the node configs in
 * ChartNode/GraphNode/MapNode/MatchNode/WolframNode/EquationNode/CalloutNode/ImageNode.
 */
import { z } from 'zod'

/**
 * The 11-character video id inside a YouTube watch / short / embed / youtu.be link, or null.
 *
 * THE source of truth for "is this an embeddable YouTube link" — YoutubeNode's renderer imports
 * it too. It used to own a private copy of this regex while `buildBlockNode` below accepted any
 * non-empty string, so the builder was strictly laxer than the renderer: Athena could insert a
 * block the editor then rendered as a bare "Video unavailable" box, counted as a successful
 * insert. One rule, imported twice, cannot drift.
 *
 * Note what this deliberately does NOT do: prove the video EXISTS. A fabricated id is still
 * well-formed — Athena was observed grounding a real lesson on toptechboy.com and then inventing
 * `watch?v=pD4UqjS3W2A` for it (oEmbed 404). Catching that needs a network call, so it is the
 * renderer's job (it can be async); this only rejects what is not a YouTube link at all.
 */
/** A YouTube video id is exactly 11 chars of base64url. Anchored, so nothing longer sneaks by. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/** True for youtube.com and its subdomains — NOT for `evilyoutube.com`, which a naive
 *  `endsWith('youtube.com')` would happily accept. */
function isYoutubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'youtube-nocookie.com' ||
    h.endsWith('.youtube-nocookie.com')
  )
}

export function youtubeVideoId(src: unknown): string | null {
  if (typeof src !== 'string' || !src.trim()) return null
  let url: URL
  try {
    url = new URL(src.trim())
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol)) return null

  let id: string | null = null
  if (url.hostname.toLowerCase() === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null
  } else if (isYoutubeHost(url.hostname)) {
    // Parsed, not pattern-matched. A real share URL puts params in ANY order
    // (`watch?si=…&v=ID`, `watch?app=desktop&v=ID`), and the previous regex required
    // `watch?v=` to be adjacent — so it silently rejected the most common link a professor
    // would paste, and the builder then dropped their video as "unusable".
    if (url.pathname === '/watch') id = url.searchParams.get('v')
    else if (url.pathname.startsWith('/embed/') || url.pathname.startsWith('/shorts/')) {
      id = url.pathname.split('/')[2] ?? null
    }
  }
  return id && VIDEO_ID.test(id) ? id : null
}

/** True for an absolute http(s) URL. Blocks that embed a remote resource need one. */
function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    return /^https?:$/.test(new URL(value.trim()).protocol)
  } catch {
    return false
  }
}

export const DOC_BLOCK_TYPES = [
  'callout',
  'equation',
  'chart',
  'graph',
  'map',
  'match',
  'wolfram',
  'image',
  'youtube',
] as const
export type DocBlockType = (typeof DOC_BLOCK_TYPES)[number]

const chartConfig = z.object({
  type: z.enum(['line', 'bar', 'scatter', 'area', 'pie', 'radar']).default('line'),
  title: z.string().default('Chart'),
  points: z.array(z.object({ x: z.string(), y: z.number() })).default([]),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
  xMin: z.number().optional(),
  xMax: z.number().optional(),
  yMin: z.number().optional(),
  yMax: z.number().optional(),
  showGrid: z.boolean().optional(),
  functions: z.array(z.object({ expr: z.string(), label: z.string().optional() })).optional(),
})

const graphConfig = z.object({
  title: z.string().default('Function graph'),
  xMin: z.number().default(-6),
  xMax: z.number().default(6),
  functions: z.array(z.object({ expr: z.string(), label: z.string().default('f') })).default([{ expr: 'sin(x)', label: 'f' }]),
})

const mapConfig = z.object({
  center: z.tuple([z.number(), z.number()]).default([20, 0]),
  zoom: z.number().default(2),
  markers: z.array(z.object({ lat: z.number(), lng: z.number(), label: z.string().default('') })).default([]),
})

const matchConfig = z.object({
  prompt: z.string().default('Match each term with its definition.'),
  points: z.number().default(5),
  pairs: z.array(z.object({ left: z.string(), right: z.string() })).default([]),
  distractors: z.array(z.object({ text: z.string() })).default([]),
})

const wolframConfig = z.object({
  query: z.string().default(''),
  tool: z.enum(['worked', 'plot', 'value', 'steps']).default('worked'),
})

/** Wrap raw config JSON in `data` for the atom nodes that store their config there. */
function dataAttrs(data: unknown, width = 100): Record<string, unknown> {
  return { data: JSON.stringify(data), width }
}

/**
 * Build the ProseMirror node JSON for a rich block, or null if the config is unusable.
 * `text` carries the callout body / equation latex / youtube url (things that aren't
 * naturally a JSON object).
 */
export function buildBlockNode(
  blockType: string,
  rawConfig: string | undefined,
  text: string | undefined,
): Record<string, unknown> | null {
  let cfg: Record<string, unknown> = {}
  if (rawConfig) {
    try {
      const parsed = JSON.parse(rawConfig)
      if (parsed && typeof parsed === 'object') cfg = parsed as Record<string, unknown>
    } catch {
      return null // malformed JSON → skip (adapter reports not-applied)
    }
  }

  switch (blockType) {
    case 'callout': {
      const variant = ['info', 'warning', 'success', 'danger'].includes(cfg.variant as string)
        ? (cfg.variant as string)
        : 'info'
      const body = String(text ?? cfg.text ?? '')
      return {
        type: 'callout',
        attrs: { variant },
        content: [body ? { type: 'paragraph', content: [{ type: 'text', text: body }] } : { type: 'paragraph' }],
      }
    }
    case 'equation': {
      const latex = String(cfg.latex ?? text ?? '').trim()
      if (!latex) return null
      return { type: 'equation', attrs: { latex, width: 100 } }
    }
    case 'chart': {
      const p = chartConfig.safeParse(cfg)
      return p.success ? { type: 'chart', attrs: dataAttrs(p.data) } : null
    }
    case 'graph': {
      const p = graphConfig.safeParse(cfg)
      return p.success ? { type: 'graph', attrs: dataAttrs(p.data) } : null
    }
    case 'map': {
      const p = mapConfig.safeParse(cfg)
      return p.success ? { type: 'map', attrs: dataAttrs(p.data) } : null
    }
    case 'match': {
      const p = matchConfig.safeParse(cfg)
      if (!p.success) return null
      // The node needs stable ids on pairs/distractors; generate them deterministically.
      const data = {
        ...p.data,
        pairs: p.data.pairs.map((pr, i) => ({ id: `p${i + 1}`, ...pr })),
        distractors: p.data.distractors.map((d, i) => ({ id: `d${i + 1}`, ...d })),
      }
      return { type: 'match', attrs: { data: JSON.stringify(data) } }
    }
    case 'wolfram': {
      const p = wolframConfig.safeParse(cfg)
      return p.success ? { type: 'wolfram', attrs: dataAttrs(p.data) } : null
    }
    case 'image': {
      // Must be a real absolute http(s) URL, not merely non-empty: a relative path or a
      // "[PLACEHOLDER]" both used to become an <img> with a permanently broken src.
      const src = String(cfg.src ?? '').trim()
      if (!isHttpUrl(src)) return null
      return { type: 'image', attrs: { src, alt: String(cfg.alt ?? ''), width: 50, align: 'center' } }
    }
    case 'youtube': {
      // Must be a link the renderer can actually embed — see youtubeVideoId. Accepting any
      // non-empty string here is what let "Added 3 blocks" report success over a video the
      // professor could not see.
      const src = String(cfg.src ?? text ?? '').trim()
      if (!youtubeVideoId(src)) return null
      return { type: 'youtube', attrs: { src } }
    }
    default:
      return null
  }
}
