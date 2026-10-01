'use client'

import { format, isSameDay } from 'date-fns'

interface DayColumnHeaderProps {
  date: Date
  today: Date
}

export function DayColumnHeader({ date, today }: DayColumnHeaderProps) {
  const isToday = isSameDay(date, today)

  return (
    <div className="text-center py-2 border-b border-border">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">
        {format(date, 'EEE')}
      </p>
      <p
        className={`text-sm font-semibold mt-0.5 tabular-nums ${
          isToday
            ? 'bg-primary text-primary-foreground rounded-full w-7 h-7 flex items-center justify-center mx-auto'
            : ''
        }`}
      >
        {format(date, 'd')}
      </p>
    </div>
  )
}
