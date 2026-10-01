/**
 * SolverNode — a TipTap block that runs a Solver query and prints the full answer into the
 * document, with an accept / try-again flow.
 *
 * Flow: type a query, pick a tool (Worked solution · Graph · Physics), Run → the complete result is
 * rendered right here with proper KaTeX (via StudioMarkdown) → Accept it (commits into the doc) or
 * Cancel to run a different query. The accepted result is cached in the node so it persists and
 * shows to students without re-fetching. The AppID stays server-side (generateSolverSolution),
 * with the section id handed in via editor storage.
 */
'use client'

import { useState, useCallback } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { toast } from 'sonner'
import { Loader2, Check, X, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { StudioMarkdown } from './shared/StudioMarkdown'
// Backend keeps the Wolfram names (the actual Wolfram|Alpha integration); the UI calls it "Solver".
import { generateWolframSolution as generateSolverSolution } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import type { WolframTool as SolverTool } from '@/lib/wolfram/client'
import { BlockChrome } from './shared/BlockChrome'
import type { BlockAlign } from './shared/BlockChrome'

export interface SolverConfig {
  query: string
  tool: SolverTool
  text?: string
  markdown?: string
  imageUrl?: string
}

export const SOLVER_DEFAULT: SolverConfig = { query: '', tool: 'worked' }

const TOOLS: { tool: SolverTool; label: string; hint: string }[] = [
  { tool: 'worked', label: 'Worked solution', hint: 'Step-by-step solution' },
  { tool: 'plot', label: 'Graph', hint: 'A plot of the expression' },
  { tool: 'physics', label: 'Physics', hint: 'Quantity with units' },
]

function parseConfig(raw: string): SolverConfig {
  try { return JSON.parse(raw) as SolverConfig } catch { return SOLVER_DEFAULT }
}
const hasResult = (c: { text?: string; markdown?: string; imageUrl?: string }) => !!(c.imageUrl || c.markdown || c.text)

function Result({ r }: { r: { text?: string; markdown?: string; imageUrl?: string } }) {
  if (r.imageUrl) {
    // Plain <img>: a public Wolfram URL, no markdown pipeline / next-image loader.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={r.imageUrl} alt="Solver result" className="mx-auto max-w-full rounded-xl border border-border bg-white" />
  }
  if (r.markdown) return <StudioMarkdown content={r.markdown} />
  if (r.text) return <StudioMarkdown content={r.text} />
  return <p className="text-sm text-muted-foreground">No result.</p>
}

function SolverNodeView({ node, updateAttributes, deleteNode, getPos, selected, editor }: NodeViewProps) {
  const config = parseConfig(node.attrs.data as string)
  const canEdit = editor.isEditable
  const width = (node.attrs.width as number | null) ?? 100
  const align = ((node.attrs.align as string | null) ?? 'center') as BlockAlign
  const [editing, setEditing] = useState(canEdit && !hasResult(config))
  const [query, setQuery] = useState(config.query)
  const [tool, setTool] = useState<SolverTool>(config.tool)
  const [running, setRunning] = useState(false)
  // A fetched-but-not-yet-accepted result (the accept/cancel preview).
  const [preview, setPreview] = useState<{ text?: string; markdown?: string; imageUrl?: string } | null>(null)

  async function run() {
    const q = query.trim()
    if (!q) { toast.error('Type a question first.'); return }
    const sectionId = (editor.storage.wolfram as { sectionId: string } | undefined)?.sectionId
    if (!sectionId) { toast.error('Reopen the document and try again.'); return }
    setRunning(true)
    const res = await generateSolverSolution(sectionId, tool, q)
    setRunning(false)
    if ('error' in res) { toast.error(res.error); return }
    setPreview({ text: res.text, markdown: res.markdown, imageUrl: res.imageUrl })
  }

  const accept = useCallback(() => {
    if (!preview) return
    updateAttributes({ data: JSON.stringify({ query: query.trim(), tool, ...preview }) })
    setPreview(null)
    setEditing(false)
  }, [preview, query, tool, updateAttributes])

  function cancel() {
    // Discard the fetched result; stay in edit to try a different query/tool.
    setPreview(null)
  }

  const handleDuplicate = useCallback(() => {
    if (typeof getPos !== 'function') return
    editor.chain().insertContentAt(getPos() + node.nodeSize, node.toJSON()).run()
  }, [editor, getPos, node])

  return (
    <NodeViewWrapper>
      <BlockChrome
        editor={editor}
        selected={selected}
        onEdit={() => { setEditing(true); setPreview(null) }}
        onDelete={deleteNode}
        onDuplicate={handleDuplicate}
        editLabel="Edit Solver"
        align={align}
        onAlign={(a) => updateAttributes({ align: a })}
        width={width}
        onResize={(pct) => updateAttributes({ width: pct })}
      >
        {/* Just the question on top — no "Solver · Worked solution" chrome. */}
        {(editing ? query : config.query) && (
          <div className="mb-2 flex items-center gap-1.5">
            <Bot className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-medium text-foreground">{editing ? query : config.query}</span>
          </div>
        )}

        {!editing ? (
          <div className="rounded-xl border border-border bg-background p-3">
            <Result r={config} />
          </div>
        ) : (
          <div className={cn('space-y-3', hasResult(config) && 'border-t border-border pt-3')}>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void run() } }}
              placeholder="e.g. solve x^2 - 5x + 6 = 0"
              className="h-9 text-sm"
            />
            <div className="flex flex-wrap gap-1.5">
              {TOOLS.map((t) => (
                <button
                  key={t.tool}
                  type="button"
                  title={t.hint}
                  onClick={() => setTool(t.tool)}
                  className={cn(
                    'rounded-xl border px-2.5 py-1 text-xs font-medium transition-colors',
                    tool === t.tool ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:bg-accent',
                  )}
                >
                  {t.label}
                </button>
              ))}
              <Button type="button" size="sm" variant="secondary" className="ml-auto" onClick={run} disabled={running}>
                {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
                {running ? 'Running…' : 'Run'}
              </Button>
            </div>

            {preview && (
              <div className="space-y-2">
                <div className="max-h-96 overflow-auto rounded-xl border border-border bg-background p-3">
                  <Result r={preview} />
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={cancel}>
                    <X className="h-3.5 w-3.5" /> Try another
                  </Button>
                  <Button type="button" size="sm" onClick={accept}>
                    <Check className="h-3.5 w-3.5" /> Accept
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </BlockChrome>
    </NodeViewWrapper>
  )
}

export const SolverNode = Node.create({
  // kept as 'wolfram' for backward-compat with stored content
  name: 'wolfram',
  group: 'block',
  atom: true,

  addStorage() {
    // DocumentStudio sets sectionId here on create; read-only viewers leave it empty (no runs).
    return { sectionId: '' }
  },

  addAttributes() {
    return {
      data: {
        default: JSON.stringify(SOLVER_DEFAULT),
        parseHTML: (el) => el.getAttribute('data-wolfram') ?? JSON.stringify(SOLVER_DEFAULT),
        renderHTML: (attrs) => ({ 'data-wolfram': attrs.data as string }),
      },
      width: {
        default: 100,
        parseHTML: (el) => { const v = el.getAttribute('data-width'); return v ? Number(v) : 100 },
        renderHTML: (attrs) => ({ 'data-width': String(attrs.width ?? 100) }),
      },
      align: {
        default: 'center',
        parseHTML: (el) => el.getAttribute('data-align') ?? 'center',
        renderHTML: (attrs) => ({ 'data-align': (attrs.align as string) ?? 'center' }),
      },
    }
  },
  parseHTML() { return [{ tag: 'div[data-wolfram]' }] },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes({ 'data-wolfram': '' }, HTMLAttributes)] },
  addNodeView() { return ReactNodeViewRenderer(SolverNodeView) },
})
