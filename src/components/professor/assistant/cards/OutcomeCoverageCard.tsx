'use client'

/**
 * Compact ABET outcome-coverage card — the minimal, glanceable read of a
 * finished alignment run, rendered on Athena's side (from the show_outcome_coverage
 * tool result). Deliberately dense like StudentPerformanceCard: a small stat grid
 * + one row per Student Outcome with a level badge. Per-indicator detail sits
 * behind a collapsed toggle so the default view stays small — no giant scroll.
 */

import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type Level = 'I' | 'R' | 'M'
const LEVEL_LABEL: Record<Level, string> = { I: 'Introduced', R: 'Reinforced', M: 'Mastered' }
const LEVEL_VARIANT: Record<Level, 'default' | 'secondary' | 'outline'> = { M: 'default', R: 'secondary', I: 'outline' }

interface CoverageIndicator { code: string; description: string; level: Level | null; evidence: string | null; attainment: number | null }
interface CoverageOutcome { code: string; name: string; bestLevel: Level | null; covered: number; total: number; indicators: CoverageIndicator[] }
/* Mirrors OutcomeCoverage in @/lib/ai/professor-assistant/outcome-coverage, which cannot be
   imported here because it is server-only. The tool output arrives untyped from the AI SDK,
   so nothing checks these two against each other — keep them in step by hand. */
interface OutcomeCoverage {
  available: boolean
  standard: string | null
  analysisState: 'never_run' | 'ready'
  runInFlight: boolean
  lastAnalyzedAt: string | null
  lastSummary: string | null
  overall: { outcomesCovered: number; outcomesTotal: number; indicatorsCovered: number; indicatorsTotal: number; gapCount: number }
  outcomes: CoverageOutcome[]
  gapOutcomes: string[]
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2">
      <p className="text-sm font-semibold tabular-nums text-foreground">{value}</p>
      {/* Wrap rather than truncate — the label is the only thing that gives the stat meaning. */}
      <p className="text-xs leading-tight text-muted-foreground">{label}</p>
    </div>
  )
}

export function OutcomeCoverageCard({ output }: { output: OutcomeCoverage | null }) {
  const [openCode, setOpenCode] = useState<string | null>(null)

  /* `available` is about the ABET reference data being seeded; `analysisState` is about
     THIS course. They used to be the same question, so a section that had simply never
     been analysed rendered the real grid at 0 of 19 with every outcome flagged as a gap —
     "not measured" drawn as "covers nothing". Both now land here instead. */
  /* The `analysisState == null && nothing covered` arm catches REPLAYED history. Tool
     outputs are persisted verbatim in athena_messages, so reopening a conversation from
     before this field existed renders a payload with no analysisState at all. Such a
     payload showing zero covered indicators is the old all-gap misreport, which is exactly
     what this card must stop drawing — and `undefined !== 'never_run'` would have waved it
     straight through. A legacy payload with real coverage still renders normally. */
  if (
    !output ||
    typeof output !== 'object' ||
    !output.available ||
    output.analysisState === 'never_run' ||
    (output.analysisState == null && output.overall?.indicatorsCovered === 0)
  ) {
    return (
      <div className="overflow-hidden rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
        No coverage yet — ask me to run the ABET outcomes analysis first.
      </div>
    )
  }

  const { overall } = output

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {/* No title here — the enclosing tool step already labels this "Outcome coverage". */}
      {output.standard && (
        /* A flex row, not one truncating line. Appended inside the truncate, the date was
           the first thing cut on a phone — "analysed 6/…" reads as data rather than as
           truncation, and the standard name, which never changes, was holding the line
           hostage against the one element that does. The name absorbs the squeeze instead.
           No live "refreshing" marker here: this card is persisted verbatim in the chat
           transcript and replayed, so a present-tense claim would still say "refreshing"
           tomorrow. AlignmentJobChip owns live status and is driven by current state. */
        <p className="flex items-center gap-1 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={output.standard}>vs {output.standard}</span>
          {/* The date the course was READ, which a re-run that changed nothing does not
              advance. Relative, because the question it answers is "are my recent edits in
              here?" and a bare 6/2/2026 makes the professor do that subtraction. */}
          {output.lastAnalyzedAt && (
            <span className="shrink-0" title={new Date(output.lastAnalyzedAt).toLocaleString()}>
              · analysed {formatDistanceToNow(new Date(output.lastAnalyzedAt), { addSuffix: true })}
            </span>
          )}
        </p>
      )}

      {/* Stat grid */}
      <div className="grid grid-cols-3 gap-2 p-4">
        <Stat value={`${overall.outcomesCovered}/${overall.outcomesTotal}`} label="outcomes covered" />
        <Stat value={`${overall.indicatorsCovered}/${overall.indicatorsTotal}`} label="indicators with evidence" />
        <Stat value={`${overall.gapCount}`} label={overall.gapCount === 1 ? 'gap' : 'gaps'} />
      </div>

      {overall.gapCount > 0 && (
        <div className="flex items-center gap-1.5 border-t border-border bg-warning-muted/40 px-4 py-2.5 text-xs font-medium text-warning-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {overall.gapCount} indicator{overall.gapCount === 1 ? '' : 's'} have no supporting evidence
          {output.gapOutcomes.length > 0 && <> · gaps in {output.gapOutcomes.join(', ')}</>}
        </div>
      )}

      {/* One row per outcome — click to reveal its indicators (collapsed by default). */}
      <ul className="divide-y divide-border border-t border-border">
        {output.outcomes.map((o) => {
          const open = openCode === o.code
          return (
            <li key={o.code}>
              <button
                onClick={() => setOpenCode(open ? null : o.code)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                <span className="flex-none font-mono text-xs text-muted-foreground">{o.code}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={o.name}>{o.name}</span>
                <span className="flex-none text-xs tabular-nums text-muted-foreground">{o.covered}/{o.total}</span>
                {o.bestLevel && o.covered === o.total ? (
                  <Badge variant={LEVEL_VARIANT[o.bestLevel]} className="flex-none">{LEVEL_LABEL[o.bestLevel]}</Badge>
                ) : o.bestLevel ? (
                  // Partially covered: showing the best level alone reads as if the
                  // whole outcome reached it ("1/3 Mastered"). Name the real state.
                  <Badge
                    variant="outline"
                    className="flex-none text-muted-foreground"
                    title={`Best evidence so far: ${LEVEL_LABEL[o.bestLevel]}`}
                  >
                    Partial
                  </Badge>
                ) : (
                  // Gap is the actionable state — give it the amber warning treatment so it
                  // doesn't read as a twin of the "Introduced" outline badge.
                  <Badge variant="outline" className="flex-none border-warning/40 bg-warning-muted text-warning-muted-foreground">Gap</Badge>
                )}
              </button>
              {open && (
                <ul className="space-y-1.5 bg-muted/20 px-4 pb-3 pt-1">
                  {o.indicators.map((ind) => (
                    <li key={ind.code} className="flex items-start gap-2 text-xs">
                      <span className="mt-0.5 flex-none font-mono text-muted-foreground">{ind.code}</span>
                      <span className="min-w-0 flex-1 text-foreground">
                        {ind.description}
                        {ind.evidence && <span className="block text-muted-foreground">{ind.evidence}</span>}
                      </span>
                      {ind.level ? (
                        <Badge variant={LEVEL_VARIANT[ind.level]} title={LEVEL_LABEL[ind.level]} className="flex-none">{ind.level}</Badge>
                      ) : (
                        <Badge variant="outline" className="flex-none text-muted-foreground">—</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
