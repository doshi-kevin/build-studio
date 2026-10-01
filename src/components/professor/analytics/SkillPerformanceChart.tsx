// Horizontal bar chart of class mastery per curated skill, weakest first.
// This is the same number the roadmap's Class analytics and Athena report; it
// used to be raw quiz-tag accuracy, which disagreed with both.
'use client'

import { Bar, BarChart, XAxis, YAxis, CartesianGrid, Cell } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { MASTERY_THRESHOLDS } from '@/lib/skills/mastery'
import type { MainSkillAgg } from '@/lib/skills/aggregate'

const chartConfig = {
  score: { label: 'Mastery', color: 'var(--chart-1)' },
}

/* Banded on MASTERY_THRESHOLDS (80 / 60) rather than a local 80/50, so a 55
   does not render amber here and red on the roadmap for the same skill.
   Only meaningful when the number IS a mastery score. Under the
   percent_proficient metric it is a share of students, which these tiers do not
   describe, so that case gets one neutral colour rather than a wrong verdict. */
function masteryColor(score: number, isMasteryScore: boolean): string {
  if (!isMasteryScore) return 'var(--chart-1)'
  if (score >= MASTERY_THRESHOLDS.strong) return 'var(--success)'
  if (score >= MASTERY_THRESHOLDS.shaky) return 'var(--warning)'
  return 'var(--destructive)'
}

interface SkillPerformanceChartProps {
  /** Already weakest-first from aggregateSectionMastery, and already filtered
   *  to skills with evidence — a null classScore must never reach here. */
  data: MainSkillAgg[]
  /** The word for the class number, per the section's configured metric. */
  metricLabel: string
  /** The section's own at-risk cutoff, for the tooltip's share-below line. */
  atRiskThreshold: number
  /** Curated main skills in total, so a capped list can say it is capped. */
  totalTracked: number
}

const MAX_BARS = 15

export function SkillPerformanceChart({ data, metricLabel, atRiskThreshold, totalTracked }: SkillPerformanceChartProps) {
  if (data.length === 0) return null
  // percent_proficient reports a headcount share, not a mastery level.
  const isMasteryScore = metricLabel !== '% proficient'

  const chartData = data.slice(0, MAX_BARS).map((t) => ({
    tag: t.name.length > 20 ? t.name.slice(0, 18) + '...' : t.name,
    fullTag: t.name,
    score: t.classScore ?? 0,
    atRiskPct: t.atRiskPct,
  }))

  return (
    <Card className="rounded-xl border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Skill mastery</CardTitle>
        {/* The list is weakest-first and capped, so an uncapped title would let
            a professor read a wall of red as the whole course. Say what slice
            this is. */}
        <p className="text-xs text-muted-foreground">
          {data.length > MAX_BARS
            ? `${MAX_BARS} weakest of ${totalTracked} tracked skills`
            : `Class ${metricLabel} across ${data.length} tracked skill${data.length === 1 ? '' : 's'}`}
        </p>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={chartConfig}
          className="w-full"
          style={{ height: `${Math.max(200, chartData.length * 40)}px` }}
        >
          <BarChart data={chartData} layout="vertical" accessibilityLayer>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              fontSize={12}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <YAxis
              type="category"
              dataKey="tag"
              tickLine={false}
              axisLine={false}
              fontSize={12}
              width={120}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, _name, item) => (
                    <div className="space-y-0.5">
                      <p className="font-medium">{item.payload.fullTag}</p>
                      <p>
                        {metricLabel === '% proficient'
                          ? `${value}% of students proficient`
                          : `Class ${metricLabel}: ${value}%`}
                      </p>
                      {item.payload.atRiskPct != null && (
                        <p>{Math.round(item.payload.atRiskPct)}% of students below {atRiskThreshold}%</p>
                      )}
                    </div>
                  )}
                />
              }
            />
            <Bar dataKey="score" radius={[0, 4, 4, 0]}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={masteryColor(entry.score, isMasteryScore)} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
