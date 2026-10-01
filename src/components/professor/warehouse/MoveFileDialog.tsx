'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { WarehouseCourse, WarehouseFile } from '@/lib/validations/warehouse'

interface MoveFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: WarehouseFile | null
  courses: WarehouseCourse[]
  onMove: (fileId: string, courseId: string | null, week: number | null, topic: string) => void
}

export function MoveFileDialog({
  open,
  onOpenChange,
  file,
  courses,
  onMove,
}: MoveFileDialogProps) {
  const [courseId, setCourseId] = useState<string | null>(file?.courseId ?? null)
  const [week, setWeek] = useState<number | null>(file?.week ?? null)
  const [topic, setTopic] = useState(file?.topic ?? '')

  // Reset when file changes
  if (file && courseId !== file.courseId && !open) {
    setCourseId(file.courseId)
    setWeek(file.week)
    setTopic(file.topic)
  }

  if (!file) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o && file) {
          setCourseId(file.courseId)
          setWeek(file.week)
          setTopic(file.topic)
        }
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move File</DialogTitle>
          <DialogDescription>Move &ldquo;{file.name}&rdquo; to a different location.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Course</Label>
            <Select
              value={courseId ?? 'none'}
              onValueChange={(v) => setCourseId(v === 'none' ? null : v)}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unsorted</SelectItem>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code ? `${c.code} — ${c.name}` : c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Week</Label>
            <Input
              type="number"
              min={1}
              max={52}
              placeholder="1-52"
              value={week ?? ''}
              onChange={(e) => setWeek(e.target.value ? parseInt(e.target.value) : null)}
              className="mt-1.5"
            />
          </div>

          <div>
            <Label>Topic</Label>
            <Input
              placeholder="e.g. Backpropagation"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="mt-1.5"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onMove(file.id, courseId, week, topic)
                onOpenChange(false)
              }}
            >
              Move
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
