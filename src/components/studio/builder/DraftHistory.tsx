'use client'

import { useId } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { History } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { DraftHistoryEntry } from '@/lib/studio/builder/service'

interface DraftHistoryProps {
  entries: DraftHistoryEntry[]
  /** The last read failed: offer a retry instead of an empty list. */
  failed: boolean
  onRetry: () => void
}

/** The project's earlier drafts, newest first: one per build that produced a preview. */
export function DraftHistory({ entries, failed, onRetry }: DraftHistoryProps) {
  const headingId = useId()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="min-h-11 gap-2">
          <History className="h-4 w-4" aria-hidden="true" />
          History
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={16} aria-labelledby={headingId} className="w-80 max-w-(--radix-popover-content-available-width) rounded-2xl p-0">
        <p id={headingId} className="border-b border-border px-4 py-3 text-sm font-medium">
          Draft history
        </p>
        {failed ? (
          <div className="space-y-2 px-4 py-6">
            <p className="text-sm text-muted-foreground">Couldn’t load your draft history.</p>
            <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Each change Athena makes for you shows up here.</p>
        ) : (
          <ol className="max-h-96 overflow-y-auto">
            {entries.map((e) => (
              <li key={e.hash} className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0">
                <p className="line-clamp-2 break-words text-sm">{e.request ?? 'Your request'}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {e.createdAt && <time dateTime={e.createdAt}>{formatDistanceToNowStrict(new Date(e.createdAt), { addSuffix: true })}</time>}
                  {e.current && <Badge>Current draft</Badge>}
                  {e.undoTarget && <Badge variant="outline">Undo goes back here</Badge>}
                  {e.savedVersion && <Badge variant="secondary">Saved as version {e.savedVersion}</Badge>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </PopoverContent>
    </Popover>
  )
}
