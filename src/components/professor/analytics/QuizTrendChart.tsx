// Bar chart showing per-quiz average scores in chronological order.
// Color-coded: green (>= 80%), amber (>= 60%), red (< 60%).
'use client'

import { Bar, BarChart, XAxis, YAxis, CartesianGrid, Cell } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import type { QuizPerformance } from '@/app/(dashboard)/professor/courses/[sectionId]/grades/actions'

const chartConfig = {
  averageScore: { label: 'Average Score', color: 'var(--chart-1)' },
}

// Semantic score color: ≥80% success, ≥60% warning, else destructive.
function scoreColor(score: number): string {
  if (score >= 80) return 'var(--success)'
  if (score >= 60) return 'var(--warning)'
  return 'var(--destructive)'
}

interface QuizTrendChartProps {
  data: QuizPerformance[]
}

export function QuizTrendChart({ data }: QuizTrendChartProps) {
  if (data.length === 0) return null

  // Always label bars positionally (full title is in the tooltip) — matching
  // the gradebook table's own Q{n} column headers. Truncating only titles over
  // 15 chars used to mix conventions on one axis: a short real title like
  // "Midterm Exam" sat next to positional "Q1"/"Q2" labels for longer-titled
  // quizzes, so "Q4" looked like it meant "the 4th quiz" until it didn't.
  const chartData = data.map((q, i) => ({
    name: `Q${i + 1}`,
    fullTitle: q.quizTitle,
    averageScore: q.averageScore,
    passRate: q.passRate,
    attempts: q.attemptCount,
  }))

  return (
    <Card className="rounded-xl border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Quiz performance trend</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[280px] w-full">
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
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, _name, item) => (
                    <div className="space-y-0.5">
                      <p className="font-medium">{item.payload.fullTitle}</p>
                      <p>Average: {value}%</p>
                      <p>Pass Rate: {item.payload.passRate}%</p>
                      <p>Attempts: {item.payload.attempts}</p>
                    </div>
                  )}
                />
              }
            />
            <Bar dataKey="averageScore" radius={[4, 4, 0, 0]} minPointSize={4}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={scoreColor(entry.averageScore)} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
