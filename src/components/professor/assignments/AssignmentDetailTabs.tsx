/**
 * AssignmentDetailTabs — client tab shell for the professor assignment detail page.
 *
 * The Details and Grading tab contents are server-rendered and passed in as nodes. The Rubrics tab
 * hosts the (always-expanded) RubricEditor. The working rubric draft is held here — above the tab
 * contents — so it survives the editor unmounting when the professor switches tabs (Radix unmounts
 * inactive tab content). Persisting it in the server prop alone would reseed a stale value.
 *
 * Type: Client Component
 */
'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { RubricEditor, type RubricGenerateSources } from '@/components/professor/assignments/RubricEditor'
import { AssignmentModuleTags, type SkillTaggingState } from '@/components/professor/assignments/AssignmentModuleTags'
import type { AssignmentRubric } from '@/lib/validations/assignment'

interface Props {
  activeTab: string
  isGraded: boolean
  detailsContent: ReactNode
  gradingContent: ReactNode
  rubric: {
    sectionId: string
    assignmentId: string
    initialRubric: AssignmentRubric | null
    initialRubricDraft: AssignmentRubric | null
    generateSources: RubricGenerateSources
    totalPoints: number
  }
}

export function AssignmentDetailTabs({ activeTab, isGraded, detailsContent, gradingContent, rubric }: Props) {
  const [draft, setDraft] = useState<AssignmentRubric | null>(rubric.initialRubricDraft)
  const [skillTagging, setSkillTagging] = useState<SkillTaggingState>({
    loading: true,
    required: false,
    moduleIds: [],
    skillOptions: [],
  })

  return (
    <Tabs defaultValue={activeTab}>
      <TabsList>
        <TabsTrigger value="details">Assignment details</TabsTrigger>
        {isGraded && <TabsTrigger value="rubrics">Rubrics</TabsTrigger>}
        <TabsTrigger value="grading">Grading</TabsTrigger>
      </TabsList>

      <TabsContent value="details" className="space-y-6 pt-2">
        {detailsContent}
      </TabsContent>

      {isGraded && (
        <TabsContent value="rubrics" className="space-y-6 pt-2">
          {/* Module tagging sits right above the rubric here too — the same compulsory field
              as the studio's "Add files & rubrics" step. */}
          <AssignmentModuleTags
            sectionId={rubric.sectionId}
            assignmentId={rubric.assignmentId}
            onStateChange={setSkillTagging}
          />
          {/* One loud entry to the Answer Key Studio: professors don't dig through dropdowns,
              and the button states the outcome. */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">AI grading</p>
              <p className="text-xs text-muted-foreground">
                {rubric.generateSources.answerKeySource
                  ? 'This assignment has an answer key. Review it or re-draft the rubric from it.'
                  : 'Upload your solutions once and get draft grades for every submission.'}
              </p>
            </div>
            <Button asChild size="sm" variant={rubric.generateSources.answerKeySource ? 'outline' : 'default'}>
              <Link href={`/professor/courses/${rubric.sectionId}/assignments/${rubric.assignmentId}/answer-key`}>
                <KeyRound className="h-4 w-4" />
                {rubric.generateSources.answerKeySource ? 'Edit answer key' : 'Create answer key for grading'}
              </Link>
            </Button>
          </div>
          <RubricEditor
            sectionId={rubric.sectionId}
            assignmentId={rubric.assignmentId}
            initialRubric={rubric.initialRubric}
            initialRubricDraft={draft}
            onDraftChange={setDraft}
            collapsible={false}
            generateSources={rubric.generateSources}
            skillTagging={skillTagging}
            defaultTargetPoints={rubric.totalPoints}
          />
        </TabsContent>
      )}

      <TabsContent value="grading" className="space-y-6 pt-2">
        {gradingContent}
      </TabsContent>
    </Tabs>
  )
}
