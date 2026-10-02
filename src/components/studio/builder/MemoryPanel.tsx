'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { Bookmark, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { loadMemoriesAction, removeMemoryAction, saveMemoryAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/actions'
import type { MemoryItem } from '@/lib/studio/builder/service'
import { KIND_LABEL, MEMORY_KINDS, MEMORY_TOPICS, TOPIC_LABEL, type MemoryKind, type MemoryTopic } from '@/lib/studio/builder/memory'
import { STUDIO_MEMORY_STATEMENT_MAX_CHARS } from '@/lib/studio/limits'

interface Draft {
  /** The decision being edited, or null for a new one. */
  replaceId: string | null
  topic: MemoryTopic
  kind: MemoryKind
  statement: string
}

const NEW_DRAFT: Draft = { replaceId: null, topic: 'student_ui', kind: 'preference', statement: '' }

const updatedLabel = (iso: string) => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * "Studio remembers": the decisions Athena keeps in mind for one tool. The professor can
 * add, edit and remove them here. Only active decisions show: no suggestions waiting for
 * an answer, nothing replaced, nothing Athena worked out on its own.
 */
export function MemoryPanel({ sectionId, pluginProjectId, reloadKey }: { sectionId: string; pluginProjectId: string; reloadKey: number }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reads, setReads] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, startSave] = useTransition()
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    loadMemoriesAction({ sectionId, pluginProjectId }).then(
      (r) => {
        if (!live) return
        if ('success' in r) setItems(r.memories)
        setFailed(!('success' in r))
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [sectionId, pluginProjectId, reloadKey, reads])

  const reload = useCallback(() => {
    setFailed(false)
    setReads((n) => n + 1)
  }, [])

  const save = () => {
    if (!draft) return
    startSave(async () => {
      const r = await saveMemoryAction({ sectionId, pluginProjectId, topic: draft.topic, kind: draft.kind, statement: draft.statement, replaceId: draft.replaceId })
      if ('error' in r) {
        // About the text box, so it appears under the text box and keeps what was typed.
        setFormError(r.error)
        return
      }
      toast.success('Saved for this tool.')
      setFormError(null)
      setDraft(null)
      reload()
    })
  }

  const remove = async (item: MemoryItem) => {
    setRemoving(item.id)
    try {
      const r = await removeMemoryAction({ sectionId, pluginProjectId, memoryId: item.id })
      if ('error' in r) toast.error(r.error)
      else toast.success('Removed.')
    } catch {
      toast.error('Couldn’t remove that. Try again.')
    } finally {
      setRemoving(null)
      reload()
    }
  }

  const count = items?.length ?? 0
  const trimmed = draft?.statement.trim() ?? ''
  // A topic holds one decision, so saving into an occupied topic replaces it. Say so before it happens.
  const replacing = draft ? items?.find((i) => i.topic === draft.topic && i.id !== draft.replaceId) : undefined

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setDraft(null)
          setFormError(null)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11 gap-2">
          <Bookmark className="h-4 w-4" aria-hidden="true" />
          Studio remembers{items ? ` (${count})` : ''}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Studio remembers</DialogTitle>
          <DialogDescription>
            Decisions Athena keeps in mind each time you build this tool. Whatever you ask for in a new request still comes first.
          </DialogDescription>
        </DialogHeader>

        {failed && (
          <div className="space-y-2 rounded-2xl bg-muted p-4 text-sm">
            <p>Couldn’t load what Studio remembers for this tool.</p>
            <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {!failed && !items && (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full rounded-2xl" />
            <Skeleton className="h-20 w-full rounded-2xl" />
          </div>
        )}

        {!failed && items && items.length === 0 && !draft && (
          <EmptyState
            icon={Bookmark}
            title="Nothing remembered yet"
            description="When you tell Athena how this tool should always look or behave, it can offer to remember it. You can also add one yourself."
          />
        )}

        {items && items.length > 0 && (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className="space-y-2 rounded-2xl bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{item.topicLabel}</Badge>
                  <span className="text-xs text-muted-foreground">{item.kindLabel}</span>
                  {updatedLabel(item.updatedAt) && <span className="text-xs text-muted-foreground">Updated {updatedLabel(item.updatedAt)}</span>}
                </div>
                <p className="text-sm">{item.statement}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 gap-2"
                    disabled={removing === item.id}
                    onClick={() => {
                      setFormError(null)
                      setDraft({ replaceId: item.id, topic: item.topic, kind: item.kind, statement: item.statement })
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="min-h-11 gap-2" disabled={removing === item.id} onClick={() => void remove(item)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {removing === item.id ? 'Removing…' : 'Remove'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {draft ? (
          <form
            className="space-y-4 rounded-2xl bg-muted p-4"
            onSubmit={(e) => {
              e.preventDefault()
              save()
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="memory-statement">{draft.replaceId ? 'Change this decision' : 'What should Athena remember?'}</Label>
              <Textarea
                id="memory-statement"
                autoFocus
                rows={2}
                maxLength={STUDIO_MEMORY_STATEMENT_MAX_CHARS}
                value={draft.statement}
                placeholder="For example: Keep the student view extremely simple."
                aria-invalid={formError ? true : undefined}
                aria-describedby={formError ? 'memory-statement-error' : 'memory-statement-hint'}
                onChange={(e) => {
                  setFormError(null)
                  setDraft({ ...draft, statement: e.target.value.replace(/[\r\n\t]+/g, ' ') })
                }}
              />
              {formError ? (
                <p id="memory-statement-error" className="text-sm text-destructive">
                  {formError}
                </p>
              ) : (
                <p id="memory-statement-hint" className="text-xs text-muted-foreground">
                  {trimmed.length} of {STUDIO_MEMORY_STATEMENT_MAX_CHARS}. Describe the tool, in one sentence.
                </p>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="memory-topic">About</Label>
                <Select value={draft.topic} onValueChange={(v) => setDraft({ ...draft, topic: v as MemoryTopic })}>
                  <SelectTrigger id="memory-topic" className="min-h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MEMORY_TOPICS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {TOPIC_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label id="memory-kind-label">When should Athena use this?</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  aria-labelledby="memory-kind-label"
                  value={draft.kind}
                  onValueChange={(v) => v && setDraft({ ...draft, kind: v as MemoryKind })}
                  className="flex-wrap justify-start"
                >
                  {MEMORY_KINDS.map((k) => (
                    <ToggleGroupItem key={k} value={k} className="min-h-11 px-4">
                      {KIND_LABEL[k]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            </div>
            {replacing && (
              <p className="rounded-xl bg-card p-3 text-sm">
                This replaces: “{replacing.statement}”. A topic keeps one decision, so put anything that should stay into the new one.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="min-h-11" disabled={saving || trimmed.length === 0}>
                {saving ? 'Saving…' : replacing ? 'Replace' : 'Save'}
              </Button>
              <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          items && (
            <div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setFormError(null)
                  setDraft(NEW_DRAFT)
                }}
              >
                Add a decision
              </Button>
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  )
}
