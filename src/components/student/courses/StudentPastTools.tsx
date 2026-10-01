import Link from 'next/link'
import { Archive, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { StudioTool } from '@/lib/course-features'

interface StudentPastToolsProps {
  sectionId: string
  /** Archived tools that students could see before they were removed. */
  tools: StudioTool[]
}

/**
 * History, not navigation: course tools the professor removed, which the student can
 * still open to look at what they saved. Read-only; the tool page says so too.
 */
export function StudentPastTools({ sectionId, tools }: StudentPastToolsProps) {
  if (tools.length === 0) return null
  return (
    <section aria-labelledby="past-tools-heading" className="mx-auto mt-10 max-w-3xl space-y-3">
      <div>
        <h2 id="past-tools-heading" className="text-base font-semibold">
          Past tools
        </h2>
        <p className="text-sm text-muted-foreground">
          Removed from this course. You can look at what you saved, but you can’t add to it.
        </p>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-2xl bg-card shadow-sm">
        {tools.map((tool) => (
          <li key={tool.installationId}>
            <Link
              href={`/student/courses/${sectionId}/tools/${tool.installationId}`}
              className="flex min-h-11 items-center gap-3 px-4 py-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Archive className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium" title={tool.name}>
                {tool.name}
              </span>
              <Badge variant="secondary">Read-only</Badge>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
