'use client'

import { format, startOfWeek, endOfWeek } from 'date-fns'
import { ChevronLeft, ChevronRight, CalendarDays, CalendarPlus, List, Grid3X3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { CalendarViewMode } from './calendar-context'
import type { OfficeHours } from '@/lib/validations/calendar'

interface CalendarToolbarProps {
  viewMode: CalendarViewMode
  currentDate: Date
  officeHours: OfficeHours[]
  filterCourseId: string | null
  onViewModeChange: (mode: CalendarViewMode) => void
  onNavigatePrev: () => void
  onNavigateNext: () => void
  onNavigateToday: () => void
  onFilterCourseChange: (courseId: string | null) => void
  onAddToCalendar: () => void
}

export function CalendarToolbar({
  viewMode,
  currentDate,
  officeHours,
  filterCourseId,
  onViewModeChange,
  onNavigatePrev,
  onNavigateNext,
  onNavigateToday,
  onFilterCourseChange,
  onAddToCalendar,
}: CalendarToolbarProps) {
  // Build date range label
  let dateLabel = ''
  if (viewMode === 'day') {
    dateLabel = format(currentDate, 'EEEE, MMMM d, yyyy')
  } else if (viewMode === 'week') {
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 })
    const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 })
    dateLabel = `${format(weekStart, 'MMM d')} – ${format(weekEnd, 'MMM d, yyyy')}`
  } else {
    dateLabel = format(currentDate, 'MMMM yyyy')
  }

  // Unique courses from office hours
  const courses = Array.from(
    new Map(
      officeHours
        .filter((oh) => oh.courseId && oh.courseName)
        .map((oh) => [oh.courseId!, { id: oh.courseId!, name: oh.courseName!, code: oh.courseCode }]),
    ).values(),
  )

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Navigation */}
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={onNavigateToday}>
          Today
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNavigatePrev} aria-label={`Previous ${viewMode}`}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNavigateNext} aria-label={`Next ${viewMode}`}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Date label */}
      <h2 className="text-lg font-semibold min-w-0 truncate">{dateLabel}</h2>

      <div className="flex-1" />

      {/* Course filter */}
      {courses.length > 0 && (
        <Select
          value={filterCourseId ?? 'all'}
          onValueChange={(v) => onFilterCourseChange(v === 'all' ? null : v)}
        >
          <SelectTrigger className="w-[160px] h-8 text-xs">
            <SelectValue placeholder="All Courses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Courses</SelectItem>
            {courses.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.code ? `${c.code}` : c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* View mode toggle */}
      <ToggleGroup
        type="single"
        value={viewMode}
        onValueChange={(v) => {
          if (v) onViewModeChange(v as CalendarViewMode)
        }}
        className="h-8"
      >
        <ToggleGroupItem value="day" aria-label="Day view" className="h-8 px-2.5 text-xs">
          <List className="h-3.5 w-3.5 mr-1" />
          Day
        </ToggleGroupItem>
        <ToggleGroupItem value="week" aria-label="Week view" className="h-8 px-2.5 text-xs">
          <CalendarDays className="h-3.5 w-3.5 mr-1" />
          Week
        </ToggleGroupItem>
        <ToggleGroupItem value="month" aria-label="Month view" className="h-8 px-2.5 text-xs">
          <Grid3X3 className="h-3.5 w-3.5 mr-1" />
          Month
        </ToggleGroupItem>
      </ToggleGroup>

      {/* Actions — one entry point for office hours + events */}
      <Button size="sm" onClick={onAddToCalendar}>
        <CalendarPlus className="h-3.5 w-3.5 mr-1.5" />
        Add to calendar
      </Button>
    </div>
  )
}
