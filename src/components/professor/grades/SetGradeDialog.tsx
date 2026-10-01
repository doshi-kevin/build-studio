// Dialog for professors to set or update a student's final letter grade
// and numeric score. Uses a popover-style dialog with dropdown + input.
'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { updateStudentFinalGrade } from '@/app/(dashboard)/professor/courses/[sectionId]/grades/actions'

const LETTER_GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'] as const

/* Radix Select reserves '' for "no selection", so a clear option needs a real sentinel value
   that is mapped back to null on save (#621). Without it a letter grade set by mistake — wrong
   student, or set before final marks were decided — was permanent short of a DB edit, even
   though the numeric field and the server schema both accept null. */
const NO_GRADE = '__none__'

// Semantic color for a letter grade: A/B → success, C → warning, D/F → destructive.
function gradeColorClass(grade: string): string {
  const letter = grade.charAt(0)
  if (letter === 'A' || letter === 'B') return 'text-success-muted-foreground'
  if (letter === 'C') return 'text-warning-muted-foreground'
  return 'text-destructive'
}

interface SetGradeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  studentId: string
  studentName: string
  currentGrade: string | null
  currentScore: number | null
}

export function SetGradeDialog({
  open,
  onOpenChange,
  sectionId,
  studentId,
  studentName,
  currentGrade,
  currentScore,
}: SetGradeDialogProps) {
  const [grade, setGrade] = useState<string>(currentGrade || '')
  const [score, setScore] = useState<string>(currentScore != null ? String(currentScore) : '')
  const [isPending, startTransition] = useTransition()

  function handleSave() {
    const finalGrade = grade === NO_GRADE || grade === '' ? null : grade
    const finalScore = score !== '' ? Number(score) : null

    if (finalScore != null && (isNaN(finalScore) || finalScore < 0 || finalScore > 100)) {
      toast.error('Score must be between 0 and 100')
      return
    }

    startTransition(async () => {
      const result = await updateStudentFinalGrade(sectionId, studentId, finalGrade, finalScore)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success(`Grade updated for ${studentName}`)
        onOpenChange(false)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Final grade</DialogTitle>
          <DialogDescription>{studentName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Letter grade
            </label>
            <Select value={grade} onValueChange={setGrade}>
              <SelectTrigger className="rounded-xl">
                {grade && grade !== NO_GRADE ? (
                  <span className={cn('text-sm font-semibold', gradeColorClass(grade))}>{grade}</span>
                ) : grade === NO_GRADE ? (
                  <span className="text-sm text-muted-foreground">No letter grade</span>
                ) : (
                  <SelectValue placeholder="Select grade" />
                )}
              </SelectTrigger>
              <SelectContent className="rounded-xl">
                {/* Only offered when there is something to clear, so it never reads as a
                    selectable grade on a student who has none. */}
                {currentGrade && (
                  <SelectItem value={NO_GRADE}>
                    <span className="text-muted-foreground">No letter grade</span>
                  </SelectItem>
                )}
                {LETTER_GRADES.map((g) => (
                  <SelectItem key={g} value={g}>
                    <span className={cn('font-semibold tabular-nums', gradeColorClass(g))}>{g}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Numeric score
            </label>
            <div className="relative">
              <Input
                type="number"
                min={0}
                max={100}
                step={0.1}
                placeholder="0 – 100"
                value={score}
                onChange={(e) => setScore(e.target.value)}
                className="rounded-xl pr-8 tabular-nums"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                %
              </span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button className="rounded-xl" onClick={handleSave} disabled={isPending}>
            {isPending ? 'Saving…' : 'Save grade'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
