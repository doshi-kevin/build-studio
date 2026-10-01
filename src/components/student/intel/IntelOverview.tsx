'use client'

import { Star, Clock, ThumbsUp, BarChart3, TrendingUp, MessageSquare, Lightbulb, FileText } from 'lucide-react'
import { Bar, BarChart, XAxis, YAxis, CartesianGrid } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { RatingStars } from './RatingStars'

interface GradeDistributionEntry {
  grade: string
  count: number
}

interface ReviewStats {
  avgOverall: number
  avgDifficulty: number
  avgWorkload: number
  avgTeaching: number
  avgGrading: number
  avgHoursPerWeek: number
  wouldTakeAgainPct: number
  gradeDistribution?: GradeDistributionEntry[]
}

interface OverviewStats {
  reviewCount: number
  questionCount: number
  tipCount: number
  resourceCount: number
}

interface IntelOverviewProps {
  reviewStats: ReviewStats
  overviewStats: OverviewStats
}

interface ChartConfigEntry {
  label: string
  color: string
}

const ratingChartConfig = {
  value: {
    label: 'Rating',
    color: 'var(--chart-1)',
  },
} satisfies Record<string, ChartConfigEntry>

const gradeChartConfig = {
  count: {
    label: 'Students',
    color: 'var(--chart-2)',
  },
} satisfies Record<string, ChartConfigEntry>

export function IntelOverview({ reviewStats, overviewStats }: IntelOverviewProps) {
  const ratingData = [
    { name: 'Overall', value: reviewStats.avgOverall },
    { name: 'Difficulty', value: reviewStats.avgDifficulty },
    { name: 'Workload', value: reviewStats.avgWorkload },
    { name: 'Teaching', value: reviewStats.avgTeaching },
    { name: 'Grading', value: reviewStats.avgGrading },
  ]

  const hasGradeData = reviewStats.gradeDistribution && reviewStats.gradeDistribution.length > 0

  return (
    <div className="space-y-6">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Average Rating */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2 text-sm font-medium text-muted-foreground">
            <Star className="h-4 w-4 text-warning" />
            Average Rating
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums text-foreground">{reviewStats.avgOverall || '—'}</span>
            <span className="text-xs text-muted-foreground">/ 5</span>
          </div>
          <div className="mt-1.5">
            <RatingStars value={Math.round(reviewStats.avgOverall)} readonly size="sm" />
          </div>
          <p className="text-xs text-muted-foreground mt-1.5 tabular-nums">
            {overviewStats.reviewCount} review{overviewStats.reviewCount !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Difficulty Level */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2 text-sm font-medium text-muted-foreground">
            <TrendingUp className="h-4 w-4" />
            Difficulty Level
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums text-foreground">
              {reviewStats.avgDifficulty || '—'}
            </span>
            <span className="text-xs text-muted-foreground">/ 5</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            {reviewStats.avgDifficulty <= 2 ? 'Easy' : reviewStats.avgDifficulty <= 3 ? 'Moderate' : 'Challenging'}
          </p>
        </div>

        {/* Hours Per Week */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2 text-sm font-medium text-muted-foreground">
            <Clock className="h-4 w-4" />
            Hours / Week
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums text-foreground">
              {reviewStats.avgHoursPerWeek || '—'}
            </span>
            <span className="text-xs text-muted-foreground">hrs</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            Average reported by students
          </p>
        </div>

        {/* Would Take Again */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2 text-sm font-medium text-muted-foreground">
            <ThumbsUp className="h-4 w-4" />
            Would Take Again
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums text-foreground">
              {reviewStats.wouldTakeAgainPct || 0}%
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            of students would retake
          </p>
        </div>
      </div>

      {/* Additional Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-xl p-5 flex items-center gap-3">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-lg font-semibold tabular-nums text-foreground">{overviewStats.questionCount}</p>
            <p className="text-xs text-muted-foreground">Questions</p>
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-5 flex items-center gap-3">
          <Lightbulb className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-lg font-semibold tabular-nums text-foreground">{overviewStats.tipCount}</p>
            <p className="text-xs text-muted-foreground">Tips</p>
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-5 flex items-center gap-3">
          <FileText className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-lg font-semibold tabular-nums text-foreground">{overviewStats.resourceCount}</p>
            <p className="text-xs text-muted-foreground">Resources</p>
          </div>
        </div>
      </div>

      {/* Rating Dimensions Chart */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 text-base font-semibold text-foreground">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          Rating Breakdown
        </div>
        <p className="text-sm text-muted-foreground mt-1">Average scores across all rating dimensions</p>
        <ChartContainer config={ratingChartConfig} className="h-[220px] w-full mt-4">
          <BarChart data={ratingData} layout="vertical" margin={{ left: 20, right: 20 }}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" domain={[0, 5]} tickCount={6} />
            <YAxis type="category" dataKey="name" width={80} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="value" fill="var(--color-value)" radius={4} />
          </BarChart>
        </ChartContainer>
      </div>

      {/* Grade Distribution Chart */}
      {hasGradeData && (
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 text-base font-semibold text-foreground">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            Grade Distribution
          </div>
          <p className="text-sm text-muted-foreground mt-1">Self-reported grades from student reviews</p>
          <ChartContainer config={gradeChartConfig} className="h-[220px] w-full mt-4">
            <BarChart data={reviewStats.gradeDistribution} margin={{ left: 10, right: 10 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="grade" />
              <YAxis allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={4} />
            </BarChart>
          </ChartContainer>
        </div>
      )}
    </div>
  )
}
