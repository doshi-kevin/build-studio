'use client'

import { useState, useMemo } from 'react'
import { Plus, Lightbulb, Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { TipCard } from './TipCard'
import { AddTipDialog } from './AddTipDialog'
import { deleteContent, toggleTipVote } from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'
import { TIP_CATEGORIES, TIP_CATEGORY_LABELS } from '@/lib/validations/intel'
import { toast } from 'sonner'

interface SurvivalTip {
  id: string
  category: string
  content: string
  is_anonymous: boolean
  author_id?: string | null
  vote_count?: number
  created_at: string
  author?: { name?: string }
  author_name?: string
}

interface IntelSurvivalGuideProps {
  tips: SurvivalTip[]
  tipVotes: string[]
  sectionId: string
  userId: string
  isAlumni: boolean
}

export function IntelSurvivalGuide(props: IntelSurvivalGuideProps) {
  const { tips, tipVotes, sectionId, userId, isAlumni } = props
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  /* Confirm before removing own content — see the note in IntelQA. */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const filteredTips = useMemo(() => {
    if (selectedCategory === 'all') return tips
    return tips.filter((tip) => tip.category === selectedCategory)
  }, [tips, selectedCategory])

  const handleVote = async (tipId: string) => {
    const result = await toggleTipVote(tipId, sectionId)
    if ('error' in result && result.error) {
      toast.error(result.error)
    }
  }

  /* See IntelQA — deleteContent had no caller anywhere (#735). */
  const confirmDelete = async () => {
    if (!pendingDeleteId) return
    const tipId = pendingDeleteId
    setDeleting(true)
    const result = await deleteContent('course_tips', tipId, sectionId)
    setDeleting(false)
    setPendingDeleteId(null)
    if ('error' in result && result.error) toast.error(result.error)
    else toast.success('Tip deleted')
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Filter by category</span>
        </div>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => setDialogOpen(true)}
          disabled={!isAlumni}
          title={!isAlumni ? 'Complete this course to share tips' : ''}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Tip
        </Button>
      </div>

      {/* Category Tabs */}
      <Tabs
        value={selectedCategory}
        onValueChange={setSelectedCategory}
      >
        {/* The height override MUST carry the same variant prefix as the class it
            replaces (#737). tailwind-merge only treats two utilities as conflicting
            when their prefixes match, so a bare `h-auto` did not defeat
            tabsListVariants' `group-data-[orientation=horizontal]/tabs:h-9` — both
            survived, the list stayed 36px tall, and flex-wrap pushed the extra rows
            outside the box and on top of the content below at 390px. */}
        <TabsList className="flex flex-wrap group-data-[orientation=horizontal]/tabs:h-auto gap-1">
          <TabsTrigger value="all" className="text-xs">
            All
          </TabsTrigger>
          {TIP_CATEGORIES.map((category) => (
            <TabsTrigger key={category} value={category} className="text-xs">
              {TIP_CATEGORY_LABELS[category]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Tips List */}
      {filteredTips.length > 0 ? (
        <AnimatedList className="space-y-4">
          {filteredTips.map((tip) => (
            <AnimatedItem key={tip.id}>
              <TipCard
                tip={{
                  ...tip,
                  author_name: tip.author?.name || tip.author_name,
                }}
                hasVoted={tipVotes.includes(tip.id)}
                onVote={() => handleVote(tip.id)}
                isOwn={!!tip.author_id && tip.author_id === userId}
                onDelete={() => setPendingDeleteId(tip.id)}
              />
            </AnimatedItem>
          ))}
        </AnimatedList>
      ) : (
        <EmptyState
          variant={selectedCategory !== 'all' ? 'default' : 'teaching'}
          icon={Lightbulb}
          title={selectedCategory !== 'all' ? 'No tips in this category' : 'No tips yet'}
          description={
            selectedCategory !== 'all'
              ? 'Try selecting a different category or add the first tip.'
              : 'Share your knowledge and help future students succeed.'
          }
        />
      )}

      {/* Add Tip Dialog */}
      <AddTipDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        sectionId={sectionId}
      />

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(o) => { if (!o && !deleting) setPendingDeleteId(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your tip?</AlertDialogTitle>
            <AlertDialogDescription>
              It will be removed from this course&apos;s Survival Guide for everyone, along
              with any votes it has collected. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); void confirmDelete() }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
