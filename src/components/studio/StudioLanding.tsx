import { Blocks } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'

interface StudioLandingProps {
  /** Active tools in this course, hidden or not. */
  toolCount: number
}

/** What course assistants see on the Studio tab. Only the professor builds and runs tools. */
export function StudioLanding({ toolCount }: StudioLandingProps) {
  const tools = toolCount === 1 ? '1 tool' : `${toolCount} tools`
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-3xl">Studio</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Tools built in Studio for this course, from what the course already knows.
        </p>
      </header>
      {toolCount > 0 ? (
        <EmptyState
          variant="teaching"
          icon={Blocks}
          title={`This course has ${tools}`}
          description="Your professor builds and manages them. Only the professor can open or change them for now."
        />
      ) : (
        <EmptyState
          variant="teaching"
          icon={Blocks}
          title="Nothing built for this course yet"
          description="Tools your professor builds for this course will appear here."
        />
      )}
    </div>
  )
}
