/**
 * AIGeneratePhasesDialog — AI-powered phase generation for student projects.
 *
 * Opens a dialog where a team member picks which canvases (project_docs)
 * to feed into the LLM, previews them, then generates structured phase
 * cards via Gemini (AI decides phase count) and saves them after review.
 *
 * The doc-selection step mirrors the professor's "Generate quiz from
 * modules" flow: by default all docs are selected; the user can narrow
 * the set. If the team has no docs, we fall back to the legacy
 * `planningDoc` (single-string) prop so existing teams still work until
 * they migrate off project_teams.planning_doc.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Bot,
  Loader2,
  Calendar,
  CheckCircle2,
  FileText,
  Pin,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import {
  generatePhasesWithAI,
  batchCreateStudentPhases,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'
import { listTeamDocs } from '@/app/(dashboard)/student/courses/[sectionId]/projects/docs-actions'

// ── Types ──────────────────────────────────────────────────────

interface GeneratedPhase {
  title: string
  description: string
  start_date: string | null
  due_date: string | null
}

interface DocRow {
  id: string
  title: string
  is_pinned: boolean
  position: number
  updated_at: string
  updated_by: string | null
}

interface AIGeneratePhasesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  projectId: string
  teamId: string
  /**
   * Legacy single-string planning doc (from project_teams.planning_doc).
   * Shown only as a fallback when the team has no project_docs yet.
   */
  planningDoc: string
}

// ── Component ──────────────────────────────────────────────────

export function AIGeneratePhasesDialog({
  open,
  onOpenChange,
  sectionId,
  projectId,
  teamId,
  planningDoc,
}: AIGeneratePhasesDialogProps) {
  const router = useRouter()
  const [generatedPhases, setGeneratedPhases] = useState<GeneratedPhase[]>([])
  const [isGenerating, startGenerating] = useTransition()
  const [isSaving, setIsSaving] = useState(false)

  const [docs, setDocs] = useState<DocRow[]>([])
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set())
  const [docsLoading, setDocsLoading] = useState(false)
  const [docsError, setDocsError] = useState<string | null>(null)

  const hasResults = generatedPhases.length > 0
  const hasDocs = docs.length > 0
  const selectedCount = selectedDocIds.size

  // Fetch docs every time the dialog opens so recent creations show up.
  const fetchDocs = useCallback(async () => {
    setDocsLoading(true)
    setDocsError(null)
    const res = await listTeamDocs(teamId)
    if (res.error) {
      setDocsError(res.error)
      setDocs([])
    } else {
      const rows = res.data || []
      setDocs(rows)
      // Default: select every doc. Team members generally want the
      // broadest context on first open; they can uncheck as needed.
      setSelectedDocIds(new Set(rows.map((d) => d.id)))
    }
    setDocsLoading(false)
  }, [teamId])

  useEffect(() => {
    if (!open) return
    fetchDocs()
  }, [open, fetchDocs])

  function toggleDoc(id: string) {
    setSelectedDocIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelectedDocIds((prev) =>
      prev.size === docs.length ? new Set() : new Set(docs.map((d) => d.id)),
    )
  }

  function handleGenerate() {
    startGenerating(async () => {
      // When the team has docs, always pass the selected IDs (even if the
      // user happened to select all). When they don't, omit the arg so the
      // server falls back to the legacy planning_doc column.
      const docIds = hasDocs ? Array.from(selectedDocIds) : undefined
      const result = await generatePhasesWithAI(teamId, projectId, sectionId, docIds)

      if (result.error) {
        toast.error(result.error)
        return
      }

      if (result.data && result.data.length > 0) {
        setGeneratedPhases(result.data)
        toast.success(`Generated ${result.data.length} phases`)
      } else {
        toast.error('No phases were generated. Try adjusting your canvases.')
      }
    })
  }

  async function handleSaveAll() {
    setIsSaving(true)
    try {
      const result = await batchCreateStudentPhases(
        teamId,
        projectId,
        sectionId,
        generatedPhases,
      )

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success(`${generatedPhases.length} phases saved successfully`)
      setGeneratedPhases([])
      onOpenChange(false)
      router.refresh()
    } catch {
      toast.error('Failed to save phases')
    } finally {
      setIsSaving(false)
    }
  }

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      setGeneratedPhases([])
    }
    onOpenChange(nextOpen)
  }

  function formatDate(date: string | null): string {
    if (!date) return ''
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  const canGenerate =
    !isGenerating &&
    (hasDocs ? selectedCount > 0 : planningDoc.trim().length > 0)

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[640px] flex flex-col max-h-[85vh]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-foreground" />
            Generate Phases with AI
          </DialogTitle>
          <DialogDescription>
            Pick which canvases the AI should read, then generate a structured
            phase plan.
          </DialogDescription>
        </DialogHeader>

        {/* Pre-generation view */}
        {!hasResults && !isGenerating && (
          <div className="space-y-4">
            {docsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : docsError ? (
              <p className="text-sm text-destructive">{docsError}</p>
            ) : hasDocs ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    Canvases to include{' '}
                    <span className="text-muted-foreground font-normal">
                      ({selectedCount} of {docs.length})
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  >
                    {selectedCount === docs.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className="border rounded-xl divide-y max-h-[220px] overflow-y-auto">
                  {docs.map((doc) => {
                    const checked = selectedDocIds.has(doc.id)
                    return (
                      <label
                        key={doc.id}
                        className={cn(
                          'flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors',
                          checked && 'bg-muted/30',
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleDoc(doc.id)}
                        />
                        {doc.is_pinned ? (
                          <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="text-sm truncate flex-1">{doc.title}</span>
                      </label>
                    )
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  The AI sees the title and contents of each selected canvas.
                </p>
              </div>
            ) : planningDoc.trim().length > 0 ? (
              // No project_docs yet — show the legacy planning_doc preview.
              <div className="space-y-2">
                <p className="text-sm font-medium">Planning Doc Preview</p>
                <div className="border rounded-xl p-3 bg-muted/50 max-h-[120px] overflow-y-auto">
                  <p className="text-xs text-foreground/70 whitespace-pre-wrap line-clamp-6">
                    {planningDoc.slice(0, 500)}
                    {planningDoc.length > 500 && '...'}
                  </p>
                </div>
                <p className="text-xs text-foreground/50">
                  {planningDoc.length.toLocaleString()} characters
                </p>
              </div>
            ) : (
              // No canvases and no legacy planning doc — nothing to generate
              // from. Point the student at where they create one.
              <div className="border rounded-xl p-4 bg-muted/50">
                <p className="text-sm text-muted-foreground">
                  There&apos;s nothing to generate from yet. Create a planning
                  canvas in the{' '}
                  <span className="font-medium text-foreground">Planning</span>{' '}
                  tab (or your team&apos;s Discussions resources), then come back
                  to generate phases from it.
                </p>
              </div>
            )}

            <div className="flex justify-end pt-1">
              <Button onClick={handleGenerate} disabled={!canGenerate}>
                <Bot className="h-4 w-4 mr-2" />
                Generate Phases
              </Button>
            </div>
          </div>
        )}

        {/* Loading state */}
        {isGenerating && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-foreground" />
            <p className="text-sm text-muted-foreground">
              Reading your canvases and drafting phases...
            </p>
          </div>
        )}

        {/* Results view */}
        {hasResults && (
          <>
            <div className="flex items-center justify-between shrink-0">
              <p className="text-sm font-medium">
                Generated {generatedPhases.length} Phases
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setGeneratedPhases([]); handleGenerate() }}
                disabled={isSaving}
              >
                Regenerate
              </Button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
              <div className="space-y-3 pb-1">
                {generatedPhases.map((phase, index) => (
                  <div key={index} className="border rounded-xl p-4 space-y-2 bg-background">
                    <div className="flex items-start gap-3">
                      <div className="flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold shrink-0">
                        {index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="font-semibold text-sm text-foreground">{phase.title}</h4>
                        <p className="text-xs text-foreground/80 mt-1 whitespace-pre-wrap">
                          {phase.description}
                        </p>
                        {(phase.start_date || phase.due_date) && (
                          <div className="flex items-center gap-3 mt-2 flex-wrap">
                            {phase.start_date && (
                              <Badge variant="secondary" className="text-[10px] gap-1">
                                <Calendar className="h-2.5 w-2.5" />
                                Start: {formatDate(phase.start_date)}
                              </Badge>
                            )}
                            {phase.due_date && (
                              <Badge variant="secondary" className="text-[10px] gap-1">
                                <Calendar className="h-2.5 w-2.5" />
                                Due: {formatDate(phase.due_date)}
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <Separator className="shrink-0" />

            <div className="flex justify-end gap-3 shrink-0">
              <Button
                variant="outline"
                onClick={() => handleClose(false)}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button onClick={handleSaveAll} disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Save All {generatedPhases.length} Phases
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
