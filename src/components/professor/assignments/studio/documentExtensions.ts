/**
 * TipTap extensions for the document studio — the shared About/announcement editor extensions
 * plus KaTeX math (`$…$` / `\ce{…}`), tables, the interactive blocks, and a syntax-highlighted
 * code block. mhchem + the KaTeX stylesheet are imported here so every surface that uses these
 * extensions is styled consistently.
 *
 * The studio swaps StarterKit's plain code block for CodeBlockLowlight (colorful code) and cleans
 * the list spacing; the About/announcement editor is unaffected (it keeps the shared defaults).
 */
import 'katex/dist/katex.min.css'
import 'katex/dist/contrib/mhchem.mjs'
import { Mathematics, GlobalDragHandle, StarterKit, Placeholder } from 'novel'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import Gapcursor from '@tiptap/extension-gapcursor'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Details from '@tiptap/extension-details'
import DetailsSummary from '@tiptap/extension-details-summary'
import DetailsContent from '@tiptap/extension-details-content'
import { StudioYoutube } from './YoutubeNode'
import { createLowlight, common } from 'lowlight'
import { defaultExtensions } from '@/components/professor/about/extensions'
import { ChartNode } from './ChartNode'
import { GraphNode } from './GraphNode'
import { ImageNode } from './ImageNode'
import { MapNode } from './MapNode'
import { MatchNode } from './MatchNode'
import { SolverNode } from './SolverNode'
import { EquationNode } from './EquationNode'
import { CalloutNode } from './CalloutNode'
import { TrailingNode } from './shared/trailing-node'

const lowlight = createLowlight(common)

// Drop the shared StarterKit (we use a studio-tuned one with codeBlock off + clean lists), Novel's
// image nodes (name 'image' — ImageNode replaces it for resize + align), and the shared placeholder
// (replaced below with a studio hint that names the / and : shortcuts).
const baseExtensions = defaultExtensions.filter(
  (ext) => ext.name !== 'image' && ext.name !== 'starterKit' && ext.name !== 'placeholder',
)

// Studio empty-line hint: names the two launchers — "/" for the block menu, ":" for Athena.
const studioPlaceholder = Placeholder.configure({
  placeholder: "Type '/' to insert a block, or ':' to launch Athena",
})

const studioStarterKit = StarterKit.configure({
  bulletList: { HTMLAttributes: { class: 'list-disc list-outside' } },
  orderedList: { HTMLAttributes: { class: 'list-decimal list-outside' } },
  blockquote: { HTMLAttributes: { class: 'border-l-4 border-primary' } },
  code: { HTMLAttributes: { class: 'rounded-md bg-muted px-1.5 py-1 font-mono font-medium', spellcheck: 'false' } },
  // Replaced by CodeBlockLowlight below; custom HorizontalRule + Gapcursor added separately.
  codeBlock: false,
  horizontalRule: false,
  dropcursor: { color: 'var(--primary)', width: 3 },
  gapcursor: false,
})

// Colorful code: lowlight decorates as you type; `.hljs-*` classes are themed in globals.css.
const codeBlockLowlight = CodeBlockLowlight.configure({
  lowlight,
  HTMLAttributes: { class: 'rounded-lg border border-border bg-muted p-4 font-mono text-sm' },
})

export const documentExtensions = [
  studioStarterKit,
  ...baseExtensions,
  studioPlaceholder,
  ImageNode,
  codeBlockLowlight,
  Mathematics.configure({ katexOptions: { throwOnError: false } }),
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  // StarterKit disables gapcursor above; re-add it so the cursor can sit before/after block nodes.
  Gapcursor,
  ChartNode,
  GraphNode,
  MapNode,
  MatchNode,
  SolverNode,
  EquationNode,
  CalloutNode,
  // Notion-style collapsible "toggle": a summary row + hidden content, styled via `.studio-details`
  // in globals.css. The three nodes must be registered together (Details wraps Summary + Content).
  Details.configure({ HTMLAttributes: { class: 'studio-details' } }),
  DetailsSummary,
  DetailsContent,
  // Embedded YouTube (privacy-enhanced host, no autoplay). Iframes don't print — acceptable, like maps.
  StudioYoutube.configure({ nocookie: true, controls: true, HTMLAttributes: { class: 'studio-youtube' } }),
  // Notion-style left-gutter grip: hover a block to drag-reorder it. Styled via `.drag-handle`
  // in globals.css. Ships with novel (tiptap-extension-global-drag-handle) — no new dependency.
  GlobalDragHandle.configure({ dragHandleWidth: 22 }),
  // Keep a paragraph after code/table/atom blocks so ArrowDown can always exit them.
  TrailingNode,
]
