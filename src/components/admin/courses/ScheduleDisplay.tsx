/**
 * ScheduleDisplay — renders schedule JSONB as compact day/time badges.
 *
 * Expects a schedule object with keys like "days" (array of day names)
 * and "start_time"/"end_time". Renders as:
 * "Mon, Wed 9:00 AM - 10:15 AM" or similar.
 *
 * Also handles free-form string schedules.
 *
 * Type: Server Component (pure display)
 */

import { Clock } from 'lucide-react'

interface ScheduleEntry {
  days?: string[]
  start_time?: string
  end_time?: string
  location?: string
}

interface ScheduleDisplayProps {
  schedule: ScheduleEntry | ScheduleEntry[] | string | null
}

const DAY_ABBR: Record<string, string> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
}

function formatTime(time: string): string {
  // Handle HH:MM format → 12h format
  const parts = time.split(':')
  if (parts.length >= 2) {
    const h = parseInt(parts[0], 10)
    const m = parts[1]
    const suffix = h >= 12 ? 'PM' : 'AM'
    const hour = h % 12 || 12
    return `${hour}:${m} ${suffix}`
  }
  return time
}

function renderEntry(entry: ScheduleEntry, index: number) {
  const days = entry.days?.map(d => DAY_ABBR[d.toLowerCase()] || d).join(', ')
  const time = entry.start_time && entry.end_time
    ? `${formatTime(entry.start_time)} - ${formatTime(entry.end_time)}`
    : null

  return (
    <span
      key={index}
      className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
    >
      <Clock className="h-3 w-3 shrink-0" />
      {days && <span>{days}</span>}
      {days && time && <span className="text-muted-foreground/50">|</span>}
      {time && <span>{time}</span>}
    </span>
  )
}

export function ScheduleDisplay({ schedule }: ScheduleDisplayProps) {
  if (!schedule) return <span className="text-muted-foreground text-xs">—</span>

  if (typeof schedule === 'string') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
        <Clock className="h-3 w-3 shrink-0" />
        {schedule}
      </span>
    )
  }

  if (Array.isArray(schedule)) {
    return (
      <div className="flex flex-wrap gap-1">
        {schedule.map((entry, i) => renderEntry(entry, i))}
      </div>
    )
  }

  return renderEntry(schedule, 0)
}
