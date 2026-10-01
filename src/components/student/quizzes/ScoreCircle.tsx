'use client'

import { getGradeLetter } from '@/lib/quiz/utils'

interface ScoreCircleProps {
  score: number // 0-100
  passThreshold: number
}

// Score heatmap, matching the professor side: ≥80 success, ≥60 warning, else
// destructive. Pass/fail (vs. passThreshold) drives only the status pill below.
function tier(score: number): { arc: string; track: string; text: string } {
  if (score >= 80) {
    return { arc: 'var(--success)', track: 'var(--success-muted)', text: 'text-success-muted-foreground' }
  }
  if (score >= 60) {
    return { arc: 'var(--warning)', track: 'var(--warning-muted)', text: 'text-warning-muted-foreground' }
  }
  return { arc: 'var(--destructive)', track: 'var(--destructive-muted)', text: 'text-destructive' }
}

export function ScoreCircle({ score, passThreshold }: ScoreCircleProps) {
  const passed = score >= passThreshold
  const grade = getGradeLetter(score)
  const { arc, track, text } = tier(score)

  // SVG circle parameters
  const size = 160
  const strokeWidth = 12
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (score / 100) * circumference

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          {/* Background track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={track}
            strokeWidth={strokeWidth}
          />
          {/* Score arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={arc}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.6s ease-out' }}
          />
        </svg>
        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-4xl font-semibold tabular-nums ${text}`}>{score}%</span>
          <span className="text-lg font-semibold text-muted-foreground">{grade}</span>
        </div>
      </div>
      <span
        className={`rounded-full px-3 py-1 text-sm font-medium ${
          passed
            ? 'bg-success-muted text-success-muted-foreground'
            : 'bg-destructive-muted text-destructive-muted-foreground'
        }`}
      >
        {passed ? 'Passed' : 'Not Passed'}
      </span>
    </div>
  )
}
