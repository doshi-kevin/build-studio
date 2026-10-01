import { Blocks } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'

/** What course assistants see on the Studio tab. Only the professor builds. */
export function StudioLanding() {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-3xl">Studio</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Tools built in Studio for this course, from what the course already knows.
        </p>
      </header>
      <EmptyState
        variant="teaching"
        icon={Blocks}
        title="Nothing built for this course yet"
        description="Tools your professor builds for this course will appear here."
      />
    </div>
  )
}
