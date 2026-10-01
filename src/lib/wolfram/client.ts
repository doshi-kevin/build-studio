/**
 * Wolfram client — SERVER ONLY. Backed by the Wolfram|Alpha API.
 *
 * Reads WOLFRAM_APP_ID (a secret, never NEXT_PUBLIC) and wraps the endpoints the studio uses to
 * generate maths/physics solutions. This module must only be imported by server code (the
 * assignments server action); the AppID must never reach the browser bundle.
 *
 * Endpoints (all verified against a live AppID):
 *   - Short Answers  /v1/result      → one-line final answer
 *   - LLM API        /api/v1/llm-api → readable worked solution text
 *   - Full Results   /v2/query       → structured pods (public image URLs, physics result + equation)
 *
 * Images are always returned as PUBLIC Wolfram URLs (not data: URLs): react-markdown drops
 * over-long data: URLs, so they wouldn't render in a cell or the PDF export. Public pod URLs are
 * short and render everywhere.
 */

const BASE = 'https://api.wolframalpha.com'
const LLM_URL = 'https://www.wolframalpha.com/api/v1/llm-api'
const TIMEOUT_MS = 20000

import { formatWolframSolution, toLatex } from './format'

export type WolframTool = 'solve' | 'worked' | 'simplify' | 'physics' | 'plot' | 'snapshot'
export interface WolframOutput {
  /** Plain-text result (physics pods). */
  text?: string
  /** Rendered markdown (LaTeX math + images), for the solution tools. */
  markdown?: string
  /** Image to embed — a public Wolfram URL. */
  imageUrl?: string
}

interface Subpod { plaintext?: string; img?: { src?: string } }
interface Pod { title?: string; subpods?: Subpod[] }
interface QueryResult { success?: boolean; error?: unknown; pods?: Pod[] }

function appId(): string {
  const id = process.env.WOLFRAM_APP_ID
  if (!id) throw new Error('WOLFRAM_APP_ID is not configured')
  return id
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Wolfram request failed (${res.status})`)
  return (await res.text()).trim()
}

async function fullResult(input: string): Promise<QueryResult> {
  const url = `${BASE}/v2/query?${new URLSearchParams({ appid: appId(), input, output: 'json', format: 'plaintext,image' })}`
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Wolfram request failed (${res.status})`)
  const data = (await res.json()) as { queryresult?: QueryResult }
  return data.queryresult ?? {}
}

async function plotImageUrl(input: string): Promise<string> {
  const qr = await fullResult(input)
  if (!qr.success) throw new Error('No result for that input.')
  const pods = qr.pods ?? []
  // Prefer a pod that is actually a plot; otherwise the first non-input pod carrying an image.
  const pod =
    pods.find((p) => /plot/i.test(p.title ?? '')) ??
    pods.find((p) => !/input/i.test(p.title ?? '') && p.subpods?.some((s) => s.img?.src))
  const src = pod?.subpods?.find((s) => s.img?.src)?.img?.src
  if (!src) throw new Error('No plot image was returned for that input.')
  return src
}

async function physicsText(input: string): Promise<string> {
  const qr = await fullResult(input)
  if (!qr.success) throw new Error('No result for that input.')
  const parts: string[] = []
  for (const p of qr.pods ?? []) {
    if (/result|equation/i.test(p.title ?? '')) {
      const t = (p.subpods ?? []).map((s) => s.plaintext).filter(Boolean).join('\n')
      if (t) parts.push(`${p.title}:\n${t}`)
    }
  }
  if (!parts.length) throw new Error('No result for that input.')
  return parts.join('\n\n')
}

async function resultImageUrl(input: string): Promise<string> {
  // The primary result rendered as an image: the first non-input pod carrying an image. Uses the
  // public pod URL (short, renders in the cell + PDF) rather than the Simple API's data: URL.
  const qr = await fullResult(input)
  if (!qr.success) throw new Error('No result for that input.')
  const pod = (qr.pods ?? []).find(
    (p) => /result/i.test(p.title ?? '') && p.subpods?.some((s) => s.img?.src),
  ) ?? (qr.pods ?? []).find(
    (p) => !/input/i.test(p.title ?? '') && p.subpods?.some((s) => s.img?.src),
  )
  const src = pod?.subpods?.find((s) => s.img?.src)?.img?.src
  if (!src) throw new Error('No result image was returned for that input.')
  return src
}

/** Run a single tool against a query. Throws on failure; the caller maps errors to a message. */
export async function runWolfram(tool: WolframTool, query: string): Promise<WolframOutput> {
  switch (tool) {
    case 'solve': {
      const answer = await getText(`${BASE}/v1/result?${new URLSearchParams({ appid: appId(), i: query })}`)
      return { markdown: `$${toLatex(answer)}$` }
    }
    case 'simplify':
      // Short Answers returns "No short answer available" for simplify; the LLM API gives the
      // simplified result + alternate forms.
      return { markdown: formatWolframSolution(await getText(`${LLM_URL}?${new URLSearchParams({ appid: appId(), input: `simplify ${query}` })}`)) }
    case 'worked':
      return { markdown: formatWolframSolution(await getText(`${LLM_URL}?${new URLSearchParams({ appid: appId(), input: query })}`)) }
    case 'physics':
      return { text: await physicsText(query) }
    case 'plot':
      return { imageUrl: await plotImageUrl(query) }
    case 'snapshot':
      return { imageUrl: await resultImageUrl(query) }
  }
}
