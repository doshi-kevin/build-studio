'use client'

import { useMemo } from 'react'
import { User, Clock, BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { formatTimeDisplay } from '@/lib/calendar/utils'
import type { OfficeHours, Slot } from '@/lib/validations/calendar'
import { DAY_SHORT_LABELS } from '@/lib/validations/calendar'

interface ProfessorInfo {
  id: string
  name: string
  courses: { code: string | null; name: string | null }[]
  nextSlot: Slot | null
  nextSlotDay: string | null
}

interface ProfessorSelectorProps {
  officeHours: OfficeHours[]
  slots: Slot[]
  selectedProfessorId: string | null
  onSelect: (professorId: string) => void
}

export function ProfessorSelector({
  officeHours,
  slots,
  selectedProfessorId,
  onSelect,
}: ProfessorSelectorProps) {
  const professors = useMemo(() => {
    const profMap = new Map<string, ProfessorInfo>()

    for (const oh of officeHours) {
      if (!oh.isActive) continue
      let prof = profMap.get(oh.professorId)
      if (!prof) {
        prof = {
          id: oh.professorId,
          name: oh.professorName,
          courses: [],
          nextSlot: null,
          nextSlotDay: null,
        }
        profMap.set(oh.professorId, prof)
      }
      if (oh.courseCode && !prof.courses.some((c) => c.code === oh.courseCode)) {
        prof.courses.push({ code: oh.courseCode, name: oh.courseName })
      }
    }

    // Find next available slot for each professor
    const now = new Date()
    const todayStr = now.toISOString().split('T')[0]
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

    const availableSlots = slots
      .filter((s) => s.status === 'available')
      .filter((s) => s.date > todayStr || (s.date === todayStr && s.startTime > nowTime))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))

    for (const [profId, prof] of profMap) {
      const next = availableSlots.find((s) => s.professorId === profId)
      if (next) {
        prof.nextSlot = next
        // Find the day name from the office hours
        const oh = officeHours.find((o) => o.id === next.officeHoursId)
        prof.nextSlotDay = oh ? DAY_SHORT_LABELS[oh.dayOfWeek] : null
      }
    }

    return Array.from(profMap.values())
  }, [officeHours, slots])

  if (professors.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border py-8 text-center text-muted-foreground text-sm">
        No professors have set up office hours yet.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Select Professor
      </h3>
      <div className="space-y-2">
        {professors.map((prof) => {
          const isSelected = selectedProfessorId === prof.id
          return (
            <button
              key={prof.id}
              type="button"
              onClick={() => onSelect(prof.id)}
              className={cn(
                'w-full text-left rounded-xl border bg-card p-3 transition duration-200 ease-out',
                isSelected
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-ring/40 hover:shadow-sm',
              )}
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-full bg-muted shrink-0">
                  <User className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{prof.name}</p>
                  {prof.courses.length > 0 && (
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {prof.courses.map((c, i) => (
                        <Badge key={i} variant="secondary" className="text-[10px]">
                          <BookOpen className="h-2.5 w-2.5 mr-0.5" />
                          {c.code}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {prof.nextSlot ? (
                    <p className="text-xs text-success-muted-foreground mt-1.5 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Next: {prof.nextSlotDay} {formatTimeDisplay(prof.nextSlot.startTime)}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-1.5">
                      No available slots
                    </p>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
