/**
 * Document HTML export — renders a Notion-style document (TipTap JSON) to a printable HTML page,
 * using the same editor extensions it was authored with so headings/lists/quotes/images round-trip.
 * The browser's "Save as PDF" turns it into the downloadable PDF.
 *
 * Kept separate from export-html.tsx (which the notebook unit tests import) because this pulls in
 * the editor/novel extension chain. generateHTML uses the DOM, so call this client-side only.
 */
import { generateHTML } from '@tiptap/core'
import type { JSONContent } from 'novel'
import { documentExtensions } from '../documentExtensions'
import { wrapPrintableHtml } from './export-html'
import { renderStaticBlocks } from './block-export'

export function documentToHtml(doc: JSONContent, title: string): string {
  // Serialize with the same extensions the doc was authored with; `$…$` stays as text and is
  // rendered by the KaTeX auto-render script that wrapPrintableHtml injects.
  const raw = doc.content?.length ? generateHTML(doc, documentExtensions) : '<p><em>Empty document.</em></p>'
  // generateHTML leaves empty placeholders for the React-rendered blocks (chart/graph/wolfram);
  // swap them for standalone SVG/HTML so they appear in the download.
  const body = renderStaticBlocks(raw)
  return wrapPrintableHtml(title, body)
}
