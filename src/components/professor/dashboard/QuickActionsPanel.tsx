// Professor Quick Actions panel — vertical list of shortcut items on the dashboard.
// Each item navigates to a feature page with dialogs pre-opened via ?action=create.
// If professor has multiple sections, a course picker popover appears first.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { PROFESSOR_QUICK_ACTIONS } from '@/lib/quick-actions/registry'
import { CoursePicker } from './CoursePicker'
import type { CourseSection } from '@/lib/quick-actions/types'

interface QuickActionsPanelProps {
  sections: CourseSection[]
  /** Products the institution has not bought; their actions are not rendered. */
  unentitledFeatures?: string[]
}

export function QuickActionsPanel({ sections, unentitledFeatures = [] }: QuickActionsPanelProps) {
  const router = useRouter()
  const [pickerOpen, setPickerOpen] = useState<string | null>(null)
  const hasSections = sections.length > 0

  const handleClick = (actionId: string, routeBuilder: (id: string) => string) => {
    if (!hasSections) {
      toast.info('You need at least one course section first. Ask your admin to assign you a course.')
      return
    }
    if (sections.length === 1) {
      router.push(routeBuilder(sections[0].id))
      return
    }
    setPickerOpen(actionId)
  }

  return (
    <div className="space-y-1">
      {PROFESSOR_QUICK_ACTIONS.filter(
        (action) => !action.feature || !unentitledFeatures.includes(action.feature),
      ).map((action) => {
        const needsPicker = sections.length > 1

        const item = (
          <button
            key={action.id}
            onClick={needsPicker ? undefined : () => handleClick(action.id, action.route)}
            className={cn(
              'group flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-left',
              'hover:bg-accent/50 transition duration-200 ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'cursor-pointer',
            )}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <action.icon className="h-4 w-4" aria-hidden="true" />
            </div>

            <div className="flex-1 min-w-0">
              {/* This panel lives in a resizable rail that can get narrow enough
                  to clip the label to a few characters, so carry the full text
                  in `title` — screen readers already get it (CSS truncation
                  doesn't change the accessible name), but sighted users need a
                  way to recover it. */}
              <p
                title={action.label}
                className="text-sm font-medium text-foreground leading-tight truncate"
              >
                {action.label}
              </p>
            </div>

            <ArrowRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground/50
                         -translate-x-1 group-hover:translate-x-0 transition duration-200 ease-out"
              aria-hidden="true"
            />
          </button>
        )

        if (needsPicker) {
          return (
            <CoursePicker
              key={action.id}
              sections={sections}
              routeBuilder={action.route}
              open={pickerOpen === action.id}
              onOpenChange={(open) => setPickerOpen(open ? action.id : null)}
            >
              {item}
            </CoursePicker>
          )
        }

        return item
      })}
    </div>
  )
}
