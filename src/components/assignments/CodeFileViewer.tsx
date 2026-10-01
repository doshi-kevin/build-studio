/**
 * CodeFileViewer — read-only, line-numbered text/code display for a single file
 * extracted from a submission archive. Presentational; content is plain text (never
 * executed, never rendered as HTML).
 */
'use client'

interface CodeFileViewerProps {
  content: string
  truncated?: boolean
}

export function CodeFileViewer({ content, truncated }: CodeFileViewerProps) {
  const lines = content.split('\n')

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-muted/20">
      <div className="max-h-[60vh] overflow-auto">
        <pre className="py-2 font-mono text-xs leading-relaxed text-foreground">
          <code>
            {lines.map((line, i) => (
              <div key={i} className="flex">
                <span className="w-12 shrink-0 select-none pr-3 text-right text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="whitespace-pre-wrap break-words pr-4">{line || ' '}</span>
              </div>
            ))}
          </code>
        </pre>
      </div>
      {truncated && (
        <p className="border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          Preview truncated — this file is larger than the preview limit.
        </p>
      )}
    </div>
  )
}
