/**
 * NotebookViewer — fetches a submitted standalone `.ipynb` (parsed server-side via
 * `readSubmissionNotebook`) and renders it through the shared NotebookCells. Read-only;
 * nothing is executed.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { readSubmissionNotebook } from '@/lib/assignments/viewer-actions'
import type { ParsedNotebook } from '@/lib/assignments/notebook'
import { NotebookCells } from './NotebookCells'

interface NotebookViewerProps {
  submissionId: string
  filePath: string
}

export function NotebookViewer({ submissionId, filePath }: NotebookViewerProps) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; notebook: ParsedNotebook }
  >({ status: 'loading' })

  useEffect(() => {
    let active = true
    readSubmissionNotebook(submissionId, filePath).then((res) => {
      if (!active) return
      if ('error' in res) setState({ status: 'error', message: res.error })
      else setState({ status: 'ready', notebook: res.notebook })
    })
    return () => {
      active = false
    }
  }, [submissionId, filePath])

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading notebook…
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/20 p-4 text-sm">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{state.message}</span>
      </div>
    )
  }

  return <NotebookCells notebook={state.notebook} />
}
