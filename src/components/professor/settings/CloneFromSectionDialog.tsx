/**
 * CloneFromSectionDialog — pick a source section and import its content.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect, useTransition } from 'react'
import { toast } from 'sonner'
import { Copy, Layers, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { SEMESTER_LABELS, type Semester } from '@/lib/validations/course-assignment'
import {
  getProfessorSectionsForClone,
  cloneFromSection,
} from '@/app/(dashboard)/professor/courses/[sectionId]/settings/actions'

interface CloneFromSectionDialogProps {
  sectionId: string
}

type CloneSource = {
  id: string
  courseCode: string
  courseTitle: string
  semester: string
  year: number
  sectionCode: string
  moduleCount: number
}

export function CloneFromSectionDialog({ sectionId }: CloneFromSectionDialogProps) {
  const [open, setOpen] = useState(false)
  const [sources, setSources] = useState<CloneSource[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setSelected(null)
    getProfessorSectionsForClone(sectionId).then((result) => {
      if (result.data) setSources(result.data)
      else toast.error(result.error || 'Failed to load sections')
      setLoading(false)
    })
  }, [open, sectionId])

  const handleClone = () => {
    if (!selected) return
    startTransition(async () => {
      const result = await cloneFromSection(selected, sectionId)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success(
          `Imported ${result.modulesCopied} modules and ${result.itemsCopied} items`,
        )
        setOpen(false)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Copy className="h-3.5 w-3.5 mr-1.5" />
          Import from Previous Course
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import from Previous Course</DialogTitle>
          <DialogDescription>
            Select a course section to copy its modules, items, and about page content into this section.
            Existing modules will be replaced.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : sources.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No other course sections found. You need at least one other assigned course to import from.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto -mx-1 px-1">
            {sources.map((source) => {
              const semLabel = SEMESTER_LABELS[source.semester as Semester] || source.semester
              return (
                <button
                  key={source.id}
                  onClick={() => setSelected(source.id)}
                  className={cn(
                    'w-full text-left rounded-xl border px-3 py-2.5 transition-colors',
                    selected === source.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-muted-foreground">
                        {source.courseCode}
                      </p>
                      <p className="text-sm font-medium truncate">
                        {source.courseTitle}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="font-mono text-xs">
                        {source.sectionCode}
                      </Badge>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {semLabel} {source.year}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                    <Layers className="h-3 w-3" />
                    {source.moduleCount} {source.moduleCount === 1 ? 'module' : 'modules'}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleClone}
            disabled={!selected || isPending}
          >
            {isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden="true" />
                Importing…
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                Import Content
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
