/**
 * QuizModuleCard — renders the `list_modules` tool result as a pickable card.
 *
 * Two jobs. It shows the professor what material is actually available (many don't
 * remember what is in which module), and it makes picking deterministic: confirming a
 * selection sends a NORMAL chat message naming the lectures, so Athena resolves them to
 * ids from the tool output it already has. No second protocol, no hidden state — the
 * chat transcript stays the whole story.
 *
 * The shape is declared locally rather than imported: the loader lives in a
 * `server-only` module, and this is a client component.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { FolderOpen, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

interface ModuleFile {
  id: string
  title: string
  pages?: number
}

interface ModuleGroup {
  id: string
  title: string
  files: ModuleFile[]
}

export interface QuizModuleCardData {
  modules?: ModuleGroup[]
  totals?: { modules: number; readyFiles: number; pages: number }
  pendingFiles?: number
  note?: string
  error?: string
}

/** Narrow an untrusted tool output into the card's shape. Returns null when it isn't one. */
export function asModuleCardData(output: unknown): QuizModuleCardData | null {
  if (!output || typeof output !== 'object') return null
  const o = output as QuizModuleCardData
  if (!Array.isArray(o.modules) && !o.note && !o.error) return null
  return o
}

export function QuizModuleCard({
  data,
  onUse,
}: {
  data: QuizModuleCardData
  /** Sends a chat message on the professor's behalf. */
  onUse: (text: string) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const modules = data.modules ?? []

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pickedTitles = modules.flatMap((m) => m.files.filter((f) => picked.has(f.id)).map((f) => f.title))

  if (data.error || (!modules.length && data.note)) {
    return (
      <p className="rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {data.error ?? data.note}
      </p>
    )
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
        <p className="flex-1 text-xs font-semibold text-foreground">Your course material</p>
        {data.totals && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {data.totals.readyFiles} {data.totals.readyFiles === 1 ? 'lecture' : 'lectures'}
          </span>
        )}
      </div>

      {/* Capped: a real course is 8 modules x 5 decks = ~45 rows, which in a 384px column
          is 1500px of card. The panel autoscrolls to the bottom on every message, so an
          uncapped list arrives with its own header and first modules already scrolled past,
          and the confirm button 40 rows below the checkbox you just ticked. */}
      <div className="max-h-72 space-y-2.5 overflow-y-auto pr-1">
        {modules.map((m) => (
          <div key={m.id} role="group" aria-labelledby={`athena-mod-${m.id}`} className="space-y-1">
            <p id={`athena-mod-${m.id}`} className="text-xs font-medium text-muted-foreground">
              {m.title}
            </p>
            <ul className="space-y-1">
              {m.files.map((f) => (
                <li key={f.id}>
                  <label className="flex min-h-11 cursor-pointer items-start gap-2 md:min-h-8 rounded-md px-1 py-1 transition-colors hover:bg-muted">
                    <Checkbox
                      checked={picked.has(f.id)}
                      onCheckedChange={() => toggle(f.id)}
                      className="mt-0.5 shrink-0"
                      aria-label={`Use ${f.title} from ${m.title}`}
                    />
                    <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 text-xs text-foreground">{f.title}</span>
                    {!!f.pages && (
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {f.pages}
                        <span aria-hidden="true">p</span>
                        <span className="sr-only"> pages</span>
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {!!data.pendingFiles && (
        <p className="text-xs text-muted-foreground">
          {data.pendingFiles} more {data.pendingFiles === 1 ? 'file is' : 'files are'} still being processed.
        </p>
      )}

      {/* The instruction lives OUTSIDE the button: on a disabled button shadcn renders it at
          50% opacity, which made the only guidance in the card the least legible text in it. */}
      {picked.size === 0 ? (
        <p className="text-xs text-muted-foreground">Pick the lectures to generate from.</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {picked.size} selected · {pickedTitles.join(', ')}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="min-h-11 w-full md:min-h-9"
        disabled={picked.size === 0}
        onClick={() => {
          onUse(`Use these lectures: ${pickedTitles.map((t) => `“${t}”`).join(', ')}`)
          setPicked(new Set())
        }}
      >
        {picked.size ? `Use ${picked.size} selected` : 'Use selected'}
      </Button>
    </div>
  )
}
