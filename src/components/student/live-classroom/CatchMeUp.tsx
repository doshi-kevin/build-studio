// "Catch me up" (#54 live variant) — student-side AI summary of the
// lecture so far. The summary is shared per room and cached server-side
// (~2 min window), so opening/refreshing is cheap for the whole class.

'use client'

import { useState } from 'react'
import { Loader2, RefreshCw, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { getLectureSummary } from '@/lib/live-classroom/summary/actions'

interface Props {
  roomId: string
}

export function CatchMeUp({ roomId }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Confirmation beat after every successful refresh — without it, a refresh
  // that returns identical (cached or regenerated) content looks broken.
  const [upToDate, setUpToDate] = useState(false)

  const fetchSummary = async (isRefresh: boolean) => {
    setLoading(true)
    setError(null)
    setUpToDate(false)
    const result = await getLectureSummary(roomId)
    setLoading(false)
    if (result.error || !result.summary) {
      setError(result.error ?? 'Could not load the summary')
      return
    }
    setSummary(result.summary)
    setGeneratedAt(result.generatedAt ?? null)
    if (isRefresh) {
      setUpToDate(true)
      setTimeout(() => setUpToDate(false), 2500)
    }
  }

  const handleOpen = () => {
    setOpen(true)
    if (!summary) void fetchSummary(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="w-full flex items-center gap-3 rounded-2xl border border-border bg-muted/20 px-4 py-3 text-left transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm"
      >
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Catch me up</span>
          <span className="block text-xs text-muted-foreground">
            Joined late or zoned out? Get a summary of the lecture so far.
          </span>
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              Lecture so far
            </DialogTitle>
            <DialogDescription>
              {generatedAt ? (
                <>
                  Updated{' '}
                  {new Date(generatedAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  {upToDate && <span className="ml-2 font-medium text-success-muted-foreground">Up to date</span>}
                </>
              ) : (
                'An AI summary of everything covered in class so far.'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto scrollbar-thin pr-1">
            {loading && !summary ? (
              <div className="flex flex-col items-center justify-center gap-3 py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Summarizing the lecture so far…</p>
              </div>
            ) : error && !summary ? (
              <div className="py-10 text-center">
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => fetchSummary(false)}>
                  Try again
                </Button>
              </div>
            ) : summary ? (
              <MarkdownLatex content={summary} className="px-0.5" />
            ) : null}
          </div>

          {summary && (
            <div className="flex items-center justify-between border-t border-border pt-3">
              {error ? (
                <p className="text-xs text-muted-foreground">{error}</p>
              ) : (
                <span />
              )}
              <Button variant="outline" size="sm" onClick={() => fetchSummary(true)} disabled={loading}>
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Refresh
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
