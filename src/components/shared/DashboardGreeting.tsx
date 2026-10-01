// Dashboard greeting + date. These MUST be computed in the viewer's timezone so
// they match the (client-rendered) MiniCalendar. Rendering them in a server
// component used Node's UTC clock, which showed the wrong greeting/day in the
// evening AND caused a hydration mismatch (React #418) on every load. Same
// useSyncExternalStore + suppressHydrationWarning approach as LocalDateTime:
// the server snapshot is a stable neutral fallback, the client formats locally.
'use client'

import { useSyncExternalStore } from 'react'

const noopSubscribe = () => () => {}

export function DashboardGreeting({ firstName }: { firstName: string }) {
  const greeting = useSyncExternalStore(
    noopSubscribe,
    () => {
      const hour = new Date().getHours()
      if (hour < 12) return 'Good morning'
      if (hour < 17) return 'Good afternoon'
      return 'Good evening'
    },
    () => 'Welcome',
  )

  const dateStr = useSyncExternalStore(
    noopSubscribe,
    () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    () => '',
  )

  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-muted-foreground mb-1 min-h-4" suppressHydrationWarning>{dateStr}</p>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground" suppressHydrationWarning>
        {greeting}, {firstName}
      </h1>
    </div>
  )
}
