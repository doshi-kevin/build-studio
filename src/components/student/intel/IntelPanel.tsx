'use client'

import { Brain, ShieldCheck, Info } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/professor/PageHeader'
import { IntelOverview } from './IntelOverview'
import { IntelReviews } from './IntelReviews'
import { IntelQA } from './IntelQA'
import { IntelSurvivalGuide } from './IntelSurvivalGuide'
import { IntelResources } from './IntelResources'
import { IntelProfessorInsights } from './IntelProfessorInsights'

interface IntelReview {
  id: string
  author_id: string
  rating_overall: number
  rating_difficulty: number
  rating_workload: number
  rating_teaching: number
  rating_grading_fairness: number
  review_text?: string
  would_take_again: boolean
  grade_received?: string | null
  hours_per_week?: number | null
  is_anonymous: boolean
  helpful_count?: number
  created_at: string
  author?: { name?: string }
  author_name?: string
}

interface IntelReviewStats {
  avgOverall: number
  avgDifficulty: number
  avgWorkload: number
  avgTeaching: number
  avgGrading: number
  avgHoursPerWeek: number
  wouldTakeAgainPct: number
  gradeDistribution?: { grade: string; count: number }[]
}

interface IntelQuestion {
  id: string
  title: string
  body?: string
  is_anonymous: boolean
  answer_count: number
  created_at: string
  author?: { name?: string }
  author_name?: string
  loadedAnswers?: IntelAnswer[]
}

interface IntelAnswer {
  id: string
  body: string
  is_anonymous: boolean
  author_name?: string
  vote_count?: number
  created_at: string
  hasVoted?: boolean
  author?: { name?: string }
}

interface IntelTip {
  id: string
  category: string
  content: string
  is_anonymous: boolean
  vote_count?: number
  created_at: string
  author?: { name?: string }
  author_name?: string
}

interface IntelResource {
  id: string
  title: string
  description?: string
  category: string
  file_url: string
  file_size?: number
  is_anonymous: boolean
  author_id: string
  created_at: string
  author?: { name?: string }
  author_name?: string
}

interface IntelProfessorInsight {
  id: string
  professor_id: string
  rating_teaching: number
  rating_approachability: number
  rating_clarity: number
  insight_text?: string
  is_anonymous: boolean
  author?: { name?: string }
  professor?: { id: string; name?: string; email?: string }
}

interface IntelProfessor {
  id: string
  name?: string
  email?: string
}

interface IntelOverviewStats {
  reviewCount: number
  questionCount: number
  tipCount: number
  resourceCount: number
}

interface IntelPanelProps {
  courseId: string
  sectionId: string
  userId: string
  isAlumni: boolean
  reviews: IntelReview[]
  reviewStats: IntelReviewStats
  userReview: IntelReview | null
  questions: IntelQuestion[]
  tips: IntelTip[]
  tipVotes: string[]
  resources: IntelResource[]
  professorInsights: IntelProfessorInsight[]
  courseProfessors: IntelProfessor[]
  overviewStats: IntelOverviewStats
}

export function IntelPanel({
  courseId,
  sectionId,
  userId,
  isAlumni,
  reviews,
  reviewStats,
  userReview,
  questions,
  tips,
  tipVotes,
  resources,
  professorInsights,
  courseProfessors,
  overviewStats,
}: IntelPanelProps) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-primary" />
            Course Intelligence
          </span>
        }
        description="Reviews, tips, Q&A, and resources from students in this course."
        actions={
          isAlumni ? (
            // Same fix as ReviewCard: isAlumni only means "ever enrolled", not "graduated".
            <Badge variant="outline" className="gap-1 bg-success-muted text-success-muted-foreground border-success/30">
              <ShieldCheck className="h-3 w-3" />
              Verified Enrollment
            </Badge>
          ) : undefined
        }
      />

      {/* Info Banner for Non-Alumni */}
      {!isAlumni && (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/50 p-4">
          <Info className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">
            You can browse course intelligence. Complete this course to contribute reviews, answers, and more.
          </p>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="overview">
        {/* The height override MUST carry the same variant prefix as the class it
            replaces (#737). tailwind-merge only treats two utilities as conflicting
            when their prefixes match, so a bare `h-auto` did not defeat
            tabsListVariants' `group-data-[orientation=horizontal]/tabs:h-9` — both
            survived, the list stayed 36px tall, and flex-wrap pushed the extra rows
            outside the box and on top of the content below at 390px. */}
        <TabsList className="flex flex-wrap group-data-[orientation=horizontal]/tabs:h-auto gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="reviews" className="gap-1.5">
            Reviews
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {reviews.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="qa" className="gap-1.5">
            Q&A
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {questions.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="survival-guide" className="gap-1.5">
            Survival Guide
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {tips.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="resources" className="gap-1.5">
            Resources
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {resources.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="professor-insights">
            Professor Insights
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <IntelOverview
            reviewStats={reviewStats}
            overviewStats={overviewStats}
          />
        </TabsContent>

        <TabsContent value="reviews" className="mt-6">
          <IntelReviews
            reviews={reviews}
            sectionId={sectionId}
            userId={userId}
            isAlumni={isAlumni}
            userReview={userReview}
          />
        </TabsContent>

        <TabsContent value="qa" className="mt-6">
          <IntelQA
            questions={questions}
            sectionId={sectionId}
            userId={userId}
            isAlumni={isAlumni}
          />
        </TabsContent>

        <TabsContent value="survival-guide" className="mt-6">
          <IntelSurvivalGuide
            tips={tips}
            tipVotes={tipVotes}
            sectionId={sectionId}
            userId={userId}
            isAlumni={isAlumni}
          />
        </TabsContent>

        <TabsContent value="resources" className="mt-6">
          <IntelResources
            resources={resources}
            courseId={courseId}
            sectionId={sectionId}
            userId={userId}
            isAlumni={isAlumni}
          />
        </TabsContent>

        <TabsContent value="professor-insights" className="mt-6">
          <IntelProfessorInsights
            insights={professorInsights}
            professors={courseProfessors}
            courseId={courseId}
            sectionId={sectionId}
            userId={userId}
            isAlumni={isAlumni}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
