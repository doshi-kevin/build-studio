// Course section picker popover — shown when a professor has multiple sections
// and clicks a quick action. Lists active sections for the professor to choose.

'use client'

import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { CourseSection } from '@/lib/quick-actions/types'

const sectionAccents = [
  'bg-foreground/80',
  'bg-foreground/60',
  'bg-foreground/40',
  'bg-foreground/70',
  'bg-foreground/50',
  'bg-foreground/65',
]

interface CoursePickerProps {
  sections: CourseSection[]
  routeBuilder: (sectionId: string) => string
  children: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CoursePicker({
  sections,
  routeBuilder,
  children,
  open,
  onOpenChange,
}: CoursePickerProps) {
  const router = useRouter()

  const handleSelect = (sectionId: string) => {
    onOpenChange(false)
    router.push(routeBuilder(sectionId))
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted-foreground">
          Select a course
        </p>
        <div className="max-h-64 overflow-y-auto space-y-0.5">
          {sections.map((section, i) => (
            <button
              key={section.id}
              onClick={() => handleSelect(section.id)}
              className="group w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-left
                         hover:bg-accent/60 transition-colors cursor-pointer"
            >
              <div className={cn('h-2 w-2 rounded-full shrink-0', sectionAccents[i % sectionAccents.length])} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  {section.course?.code ?? 'Course'}
                  <span className="text-muted-foreground font-normal"> {section.section_code}</span>
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {section.course?.title ?? 'Untitled'}
                </p>
              </div>
              <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground/50 transition-colors" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
