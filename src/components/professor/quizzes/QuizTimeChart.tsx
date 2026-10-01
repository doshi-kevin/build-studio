// Bar chart showing average time spent per question, color-coded by accuracy.
// Green bars = high accuracy (easy), red bars = low accuracy (hard).
'use client'

import { Bar, BarChart, XAxis, YAxis, CartesianGrid, Cell } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import type { TimeAnalyticsRow } from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'

const chartConfig = {
  avgTime: { label: 'Avg Time (s)', color: 'var(--chart-1)' },
}

/** Color bar based on accuracy using semantic design tokens: high = success, low = destructive. */
function accuracyColor(accuracy: number): string {
  if (accuracy >= 0.8) return 'var(--success)'
  if (accuracy >= 0.5) return 'var(--warning)'
  return 'var(--destructive)'
}

/** Format seconds as "Xm Ys" or "Xs" for human-readable display. */
function formatTimeSec(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

interface QuizTimeChartProps {
  data: TimeAnalyticsRow[]
}

export function QuizTimeChart({ data }: QuizTimeChartProps) {
  if (data.length === 0) return null

  const chartData = data.map((row) => ({
    // The row's real position, not its index here — `data` is filtered to questions
    // with recorded time, so the index drifts. The summary cards above this chart
    // read the same field, and a mismatch made the two contradict each other (#311).
    name: `Q${row.position + 1}`,
    fullTitle: row.questionText.length > 80 ? row.questionText.slice(0, 80) + '…' : row.questionText,
    avgTime: row.avgTime,
    minTime: row.minTime,
    maxTime: row.maxTime,
    accuracy: row.accuracy,
    attemptCount: row.attemptCount,
  }))

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Avg Time per Question</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[260px] w-full">
          <BarChart data={chartData} accessibilityLayer>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="name"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              fontSize={12}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              fontSize={12}
              tickFormatter={formatTimeSec}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, _name, item) => (
                    <div className="space-y-0.5">
                      <p className="font-medium text-xs">{item.payload.fullTitle}</p>
                      <p className="text-xs">Avg: {formatTimeSec(value as number)}</p>
                      <p className="text-xs">
                        Range: {formatTimeSec(item.payload.minTime)} – {formatTimeSec(item.payload.maxTime)}
                      </p>
                      <p className="text-xs">Accuracy: {Math.round(item.payload.accuracy * 100)}%</p>
                      <p className="text-xs">Responses: {item.payload.attemptCount}</p>
                    </div>
                  )}
                />
              }
            />
            <Bar dataKey="avgTime" radius={[4, 4, 0, 0]} minPointSize={4}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={accuracyColor(entry.accuracy)} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
        <p className="text-xs text-muted-foreground mt-2">
          Bar color: green = high accuracy · amber = medium · red = low accuracy
        </p>
      </CardContent>
    </Card>
  )
}
