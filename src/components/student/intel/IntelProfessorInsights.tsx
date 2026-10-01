'use client'

import { useState, useMemo } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Plus, GraduationCap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState } from '@/components/ui/empty-state'
import { RatingStars } from './RatingStars'
import { AnonymousToggle } from './AnonymousToggle'
import { createProfessorInsightSchema, type CreateProfessorInsightInput } from '@/lib/validations/intel'
import { submitProfessorInsight } from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'

interface ProfessorProfile {
  id: string
  name?: string
  email?: string
}

interface ProfessorInsight {
  id: string
  professor_id: string
  rating_teaching: number
  rating_approachability: number
  rating_clarity: number
  insight_text?: string
  is_anonymous: boolean
  author?: { name?: string }
  professor?: ProfessorProfile
}

interface IntelProfessorInsightsProps {
  insights: ProfessorInsight[]
  professors: ProfessorProfile[]
  courseId: string
  sectionId: string
  userId: string
  isAlumni: boolean
}

interface ProfessorGroup {
  professor: ProfessorProfile
  insights: ProfessorInsight[]
  avgTeaching: number
  avgApproachability: number
  avgClarity: number
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function IntelProfessorInsights(props: IntelProfessorInsightsProps) {
  const { insights, professors, sectionId, isAlumni } = props
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<CreateProfessorInsightInput>({
    resolver: zodResolver(createProfessorInsightSchema) as Resolver<CreateProfessorInsightInput>,
    defaultValues: {
      professor_id: '',
      rating_teaching: 0,
      rating_approachability: 0,
      rating_clarity: 0,
      insight_text: '',
      is_anonymous: false,
    },
  })

  const professorGroups = useMemo<ProfessorGroup[]>(() => {
    const groupMap = new Map<string, ProfessorInsight[]>()

    insights.forEach((insight) => {
      const pid = insight.professor_id
      if (!groupMap.has(pid)) groupMap.set(pid, [])
      groupMap.get(pid)!.push(insight)
    })

    const groups: ProfessorGroup[] = []
    for (const [profId, profInsights] of groupMap.entries()) {
      const professor = profInsights[0]?.professor || professors.find((p) => p.id === profId)
      if (!professor) continue

      const count = profInsights.length
      const avg = (field: keyof Pick<ProfessorInsight, 'rating_teaching' | 'rating_approachability' | 'rating_clarity'>) =>
        count > 0
          ? Math.round(
              (profInsights.reduce((sum: number, i) => sum + (i[field] || 0), 0) / count) * 10
            ) / 10
          : 0

      groups.push({
        professor,
        insights: profInsights,
        avgTeaching: avg('rating_teaching'),
        avgApproachability: avg('rating_approachability'),
        avgClarity: avg('rating_clarity'),
      })
    }

    return groups
  }, [insights, professors])

  const onSubmit = async (data: CreateProfessorInsightInput) => {
    setIsSubmitting(true)
    try {
      const result = await submitProfessorInsight(sectionId, data)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Professor insight submitted')
      setDialogOpen(false)
      form.reset()
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => setDialogOpen(true)}
          disabled={!isAlumni}
          title={!isAlumni ? 'Complete this course to share insights' : ''}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Insight
        </Button>
      </div>

      {/* Professor Groups */}
      {professorGroups.length > 0 ? (
        <div className="space-y-6">
          {professorGroups.map((group) => (
            <div key={group.professor.id} className="bg-card border border-border rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarFallback>
                    {getInitials(group.professor.name || 'Unknown')}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <h3 className="text-base font-semibold text-foreground">
                    {group.professor.name || 'Unknown Professor'}
                  </h3>
                  {group.professor.email && (
                    <p className="text-xs text-muted-foreground">{group.professor.email}</p>
                  )}
                </div>
              </div>

              {/* Average Ratings */}
              {/* grid-cols-3 was unconditional, so at 390px each column was ~100px —
                  not enough for "Approachability" beside its stars and value, and the
                  labels overlapped their neighbours (#739). Each cell holds a label, a
                  star row and a number, so one column is the safe mobile shape. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4 pt-3 border-t border-border">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Teaching</p>
                  <div className="flex items-center gap-1.5">
                    <RatingStars value={Math.round(group.avgTeaching)} readonly size="sm" />
                    <span className="text-xs font-medium tabular-nums text-foreground">{group.avgTeaching}</span>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Approachability</p>
                  <div className="flex items-center gap-1.5">
                    <RatingStars value={Math.round(group.avgApproachability)} readonly size="sm" />
                    <span className="text-xs font-medium tabular-nums text-foreground">{group.avgApproachability}</span>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Clarity</p>
                  <div className="flex items-center gap-1.5">
                    <RatingStars value={Math.round(group.avgClarity)} readonly size="sm" />
                    <span className="text-xs font-medium tabular-nums text-foreground">{group.avgClarity}</span>
                  </div>
                </div>
              </div>

              {/* Insights */}
              <div className="space-y-3">
                {group.insights.map((insight) => {
                  const authorName = insight.is_anonymous
                    ? 'Anonymous Student'
                    : insight.author?.name || 'Unknown'
                  return (
                    <div
                      key={insight.id}
                      className="rounded-xl bg-muted/50 p-3"
                    >
                      {insight.insight_text && (
                        <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                          {insight.insight_text}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        — {authorName}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          variant="teaching"
          icon={GraduationCap}
          title="No professor insights yet"
          description="Share your experience with the professors who taught this course."
        />
      )}

      {/* Add Insight Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Professor Insight</DialogTitle>
            <DialogDescription>
              Share your experience with a professor who taught this course.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              {/* Professor Select */}
              <FormField
                control={form.control}
                name="professor_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Professor *</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a professor" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {professors.map((prof) => (
                          <SelectItem key={prof.id} value={prof.id}>
                            {prof.name || prof.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Rating: Teaching */}
              <FormField
                control={form.control}
                name="rating_teaching"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel>Teaching Quality *</FormLabel>
                      <FormControl>
                        <RatingStars
                          value={field.value}
                          onChange={field.onChange}
                          size="lg"
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Rating: Approachability */}
              <FormField
                control={form.control}
                name="rating_approachability"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel>Approachability *</FormLabel>
                      <FormControl>
                        <RatingStars
                          value={field.value}
                          onChange={field.onChange}
                          size="lg"
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Rating: Clarity */}
              <FormField
                control={form.control}
                name="rating_clarity"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel>Clarity *</FormLabel>
                      <FormControl>
                        <RatingStars
                          value={field.value}
                          onChange={field.onChange}
                          size="lg"
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Insight Text */}
              <FormField
                control={form.control}
                name="insight_text"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Your Insight</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Share your experience with this professor..."
                        className="resize-none"
                        rows={4}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Anonymous Toggle */}
              <FormField
                control={form.control}
                name="is_anonymous"
                render={({ field }) => (
                  <FormItem>
                    <AnonymousToggle
                      value={field.value}
                      onChange={field.onChange}
                    />
                  </FormItem>
                )}
              />

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Submitting...' : 'Submit Insight'}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
