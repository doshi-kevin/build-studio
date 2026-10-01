/**
 * Pull the external links used in a notebook so the Resources panel can mirror them.
 * Scans markdown cells for markdown links `[label](url)` and bare http(s) URLs. Pure +
 * deterministic, so Resources stays consistent as links are added/removed from cells.
 */
import type { StudioNotebook } from './notebook-model'

export interface ExtractedLink {
  label: string
  url: string
}

const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
const BARE_URL = /(?:^|[\s(])(https?:\/\/[^\s)]+)/g

export function extractNotebookLinks(notebook: StudioNotebook): ExtractedLink[] {
  const out: ExtractedLink[] = []
  const seen = new Set<string>()

  const add = (label: string, rawUrl: string) => {
    const url = rawUrl.trim().replace(/[.,;:]+$/, '')
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    out.push({ label: label.trim() || url, url })
  }

  for (const cell of notebook.cells) {
    if (cell.cell_type !== 'markdown') continue
    const src = cell.source
    const linked = new Set<string>()
    let m: RegExpExecArray | null
    MD_LINK.lastIndex = 0
    while ((m = MD_LINK.exec(src))) {
      add(m[1], m[2])
      linked.add(m[2].replace(/[.,;:]+$/, ''))
    }
    BARE_URL.lastIndex = 0
    while ((m = BARE_URL.exec(src))) {
      const url = m[1].replace(/[.,;:]+$/, '')
      if (!linked.has(url)) add('', url)
    }
  }
  return out
}
