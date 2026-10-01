'use client'

/**
 * Charts for the super-admin Cost Analysis pages. Client components (recharts);
 * the server pages pass fully-aggregated data down. Category colors come from
 * the shared CATEGORY_CHART_VARS map so the daily bars, donut, and legends stay
 * consistent everywhere.
 */

import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

import { CATEGORY_LABELS, categoryColor } from './categories'

export interface DailyPoint {
  day: string // 'MM/DD'
  [category: string]: string | number
}

export function CostDailyChart({ data, categories }: { data: DailyPoint[]; categories: string[] }) {
  const config: ChartConfig = Object.fromEntries(
    categories.map((c) => [c, { label: CATEGORY_LABELS[c] ?? c, color: categoryColor(c) }]),
  )
  return (
    <ChartContainer config={config} className="h-[260px] w-full">
      <BarChart accessibilityLayer data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} fontSize={12} />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={12}
          tickFormatter={(v: number) => `$${v}`}
          width={56}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {categories.map((c, i) => (
          <Bar key={c} dataKey={c} stackId="cost" fill={categoryColor(c)} radius={i === categories.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

export interface DonutSlice {
  key: string
  name: string
  value: number
}

export function CategoryDonut({ data }: { data: DonutSlice[] }) {
  const config: ChartConfig = Object.fromEntries(
    data.map((d) => [d.key, { label: d.name, color: categoryColor(d.key) }]),
  )
  return (
    <ChartContainer config={config} className="mx-auto h-[220px] w-full max-w-[280px]">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="key" />} />
        <ChartLegend content={<ChartLegendContent nameKey="key" />} />
        <Pie data={data} dataKey="value" nameKey="key" innerRadius={55} outerRadius={85} paddingAngle={2}>
          {data.map((d) => (
            <Cell key={d.key} fill={categoryColor(d.key)} />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  )
}
