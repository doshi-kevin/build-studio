/**
 * RubricLossChart — compact donut showing where marks were lost per rubric question.
 *
 * Presentational; no 'use client' directive. Ships inside the client StudentGradePanel
 * but stays directive-free. Caller guarantees score != null and points > 0.
 *
 * Geometry: 120x120 viewBox, r=48, strokeWidth=12, pathLength=100.
 * - Earned arc: tone color (success/warning/destructive via scoreTone)
 * - Lost arcs: one per rubric question with qLost > 0
 *   - first lost: var(--destructive)
 *   - additional: cycle var(--chart-5), --chart-4, --chart-3, --chart-2
 * - Track: var(--muted)
 * Center shows: large pct% (tone color) + small score/points below.
 * Legend: compact one-line swatch list shown only when >1 question has loss.
 * No-rubric fallback: simple earned/lost two-segment donut.
 */

import { scoreTone } from '@/lib/assignments/student-status'
import type { AssignmentRubric } from '@/lib/validations/assignment'

export interface RubricLossChartProps {
  rubric: AssignmentRubric | null
  rubricScores: string[]
  score: number
  points: number
}

const LOST_COLORS = [
  'var(--destructive)',
  'var(--chart-5)',
  'var(--chart-4)',
  'var(--chart-3)',
  'var(--chart-2)',
]

// Map scoreTone to a CSS var string for stroke
function toneColor(tone: ReturnType<typeof scoreTone>): string {
  if (tone === 'success') return 'var(--success)'
  if (tone === 'warning') return 'var(--warning)'
  return 'var(--destructive)'
}


export function RubricLossChart({ rubric, rubricScores, score, points }: RubricLossChartProps) {
  const pct = Math.round(Math.max(0, Math.min(100, (score / points) * 100)))
  const tone = scoreTone(score, points)
  const earnedColor = toneColor(tone)

  const hasRubric = rubric !== null && rubric.questions.length > 0

  // ── Per-question loss computation (mirrors StudentRubricBreakdown) ──
  interface LostSegment {
    label: string
    lostPts: number
    length: number // in pathLength=100 units
    color: string
  }

  const lostSegments: LostSegment[] = []

  if (hasRubric) {
    const earned = new Set(rubricScores)
    let lostColorIdx = 0
    for (let qi = 0; qi < rubric!.questions.length; qi++) {
      const q = rubric!.questions[qi]
      const qEarned = q.criteria.reduce(
        (sum, c, ci) => (earned.has(`${qi}:${ci}`) ? sum + c.points : sum),
        0,
      )
      const qLost = Math.max(0, q.points - qEarned)
      if (qLost > 0) {
        const length = Math.round((qLost / points) * 100)
        if (length > 0) {
          lostSegments.push({
            label: q.label || `Q${qi + 1}`,
            lostPts: qLost,
            length,
            color: LOST_COLORS[Math.min(lostColorIdx, LOST_COLORS.length - 1)],
          })
          lostColorIdx++
        }
      }
    }
  }

  // ── Segment layout (pathLength=100 coordinate space) ──
  // Earned arc gets remainder to prevent rounding drift.
  const totalLostLength = lostSegments.reduce((s, seg) => s + seg.length, 0)
  const earnedLength = Math.max(0, 100 - totalLostLength)

  // No-rubric fallback: simple two-segment donut
  const simpleLostLength = 100 - pct
  const showSimple = !hasRubric

  // Build arc list: earned first, then lost segments in order
  interface Arc {
    color: string
    length: number
    offset: number // strokeDashoffset = 100 - cumulative start in pathLength=100 space
    // SVG trick: dasharray=[length, 100-length], dashoffset=100-start
    // Because pathLength=100 wraps: dashoffset encodes where the dash begins
    // Standard: dashoffset = 100 - startPosition (circle starts at "top" with 90deg offset via transform)
  }

  const arcs: Arc[] = []
  let cursor = 0

  if (showSimple) {
    arcs.push({ color: earnedColor, length: pct, offset: 25 }) // start at top (25 = 90deg offset)
    if (simpleLostLength > 0) {
      arcs.push({ color: 'var(--destructive)', length: simpleLostLength, offset: 25 - pct })
    }
  } else {
    // Earned arc starts at top
    arcs.push({ color: earnedColor, length: earnedLength, offset: 25 - cursor })
    cursor += earnedLength
    for (const seg of lostSegments) {
      arcs.push({ color: seg.color, length: seg.length, offset: 25 - cursor })
      cursor += seg.length
    }
  }

  const showLegend = !showSimple && lostSegments.length > 1

  return (
    <div className="mx-auto w-full max-w-[140px]">
      <svg
        viewBox="0 0 120 120"
        role="img"
        aria-label={`Score ${score} out of ${points}, ${pct}%`}
        className="mx-auto w-full"
      >
        {/* Track ring */}
        <circle
          cx={60}
          cy={60}
          r={48}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={12}
        />
        {/* Score arcs */}
        {arcs.map((arc, i) =>
          arc.length > 0 ? (
            <circle
              key={i}
              cx={60}
              cy={60}
              r={48}
              fill="none"
              stroke={arc.color}
              strokeWidth={12}
              pathLength={100}
              strokeDasharray={`${arc.length} ${100 - arc.length}`}
              strokeDashoffset={arc.offset}
              className="transition-[stroke-dashoffset,stroke-dasharray] duration-700 ease-out motion-reduce:transition-none"
              style={{ transformOrigin: '60px 60px', transform: 'rotate(-90deg)' }}
            />
          ) : null,
        )}
        {/* Center: percentage */}
        <text
          x={60}
          y={55}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={22}
          fontWeight={600}
          fontFamily="inherit"
          fill={toneColor(tone)}
          className="tabular-nums"
        >
          {pct}%
        </text>
        {/* Center: score/points */}
        <text
          x={60}
          y={74}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={10}
          fontFamily="inherit"
          fill="var(--muted-foreground)"
          className="tabular-nums"
        >
          {score}/{points}
        </text>
      </svg>

      {/* Compact legend: only when >1 lost segment */}
      {showLegend && (
        <div className="mt-1 flex flex-wrap justify-center gap-x-2 gap-y-0.5">
          {lostSegments.map((seg) => (
            <span
              key={seg.label}
              className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums"
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                style={{ background: seg.color }}
                aria-hidden="true"
              />
              {seg.label} -{seg.lostPts}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
