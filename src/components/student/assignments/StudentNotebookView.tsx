/**
 * Student-facing read-only view of a published notebook assignment, plus a button to
 * download it as a `.ipynb` file (a clean working notebook, openable in Jupyter). No
 * editing, no execution.
 *
 * Shows the professor's authored pedagogy per cell (hints via a hover bulb, explanation,
 * difficulty/points/time/tags) and the assignment's reference links. The answer key is
 * NEVER shown to students, and Scholera authoring metadata is stripped from the download.
 *
 * Type: Client Component
 */
'use client'

import { Download, NotebookPen, Link2, ExternalLink, Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type StudioNotebook, serializeNotebookJson } from '@/lib/assignments/studio/notebook-model'
import { getAuthoring } from '@/lib/assignments/studio/authoring'
import { extractNotebookLinks } from '@/lib/assignments/studio/links'
import { StudioMarkdown } from '@/components/professor/assignments/studio/shared/StudioMarkdown'
import { CodeBlock } from '@/components/professor/assignments/studio/shared/CodeBlock'
import { PedagogyCorner, CellBadges } from '@/components/professor/assignments/studio/shared/CellPedagogy'

interface Resources {
  moduleTags?: string[]
  generatedLinks?: { label: string; url: string }[]
}

const isHttpUrl = (u: string) => /^https?:\/\//i.test(u)

export function StudentNotebookView({
  notebook, title, resources,
}: {
  notebook: StudioNotebook
  title: string
  resources?: Resources
}) {
  // Download the notebook as a `.ipynb` file. Strip Scholera authoring metadata
  // (answer keys, hints, points) from every cell so students get a clean working notebook
  // and the answer key never leaks through the file's metadata.
  function downloadIpynb() {
    const clean: StudioNotebook = {
      ...notebook,
      cells: notebook.cells.map((c) => {
        const metadata = { ...c.metadata }
        delete metadata.studio
        return { ...c, metadata }
      }),
    }
    const blob = new Blob([serializeNotebookJson(clean)], { type: 'application/x-ipynb+json' })
    const url = URL.createObjectURL(blob)
    const name = title.trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').toLowerCase() || 'notebook'
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.ipynb`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // Cell links + professor reference links, deduped. http(s) only (never render javascript: etc).
  const seen = new Set<string>()
  const links = [...extractNotebookLinks(notebook), ...(resources?.generatedLinks ?? [])].filter((l) => {
    if (!isHttpUrl(l.url) || seen.has(l.url)) return false
    seen.add(l.url)
    return true
  })
  const tags = resources?.moduleTags ?? []

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border p-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <NotebookPen className="h-4 w-4" aria-hidden="true" />
        </span>
        <p className="text-sm font-semibold text-foreground">Notebook</p>
        <Button size="sm" className="ml-auto" onClick={downloadIpynb}>
          <Download className="h-4 w-4" />
          Download .ipynb
        </Button>
      </div>
      <div className="space-y-4 p-4">
        {notebook.cells.map((c) => {
          const authoring = getAuthoring(c.metadata)
          return (
            <div key={c.id} className="relative">
              <div className="absolute right-0 top-0 z-10">
                <PedagogyCorner authoring={authoring} showAnswerKey={false} />
              </div>
              <div className="pr-8">
                {c.cell_type === 'markdown' ? (
                  <StudioMarkdown content={c.source} />
                ) : c.cell_type === 'code' ? (
                  <CodeBlock code={c.source || ' '} />
                ) : (
                  <pre className="whitespace-pre-wrap text-sm text-muted-foreground">{c.source}</pre>
                )}
              </div>
              <CellBadges authoring={authoring} />
            </div>
          )
        })}
      </div>

      {(links.length > 0 || tags.length > 0) && (
        <div className="space-y-3 border-t border-border p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Link2 className="h-4 w-4 text-muted-foreground" /> Resources
          </p>
          {links.length > 0 && (
            <ul className="space-y-1">
              {links.map((l) => (
                <li key={l.url}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-1.5 truncate rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    title={l.url}
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="truncate">{l.label || l.url}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                  <Tag className="h-3 w-3 text-muted-foreground" /> {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
