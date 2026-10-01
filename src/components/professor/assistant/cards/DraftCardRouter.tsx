'use client'

/**
 * Maps an AI-SDK tool part to the right card, based on the tool name and the
 * part's state (input-streaming → drafting skeleton; input-available → editable
 * card; output-available → resolved/insights view). For the four DRAFT tools,
 * `onResolve` writes the tool result (approve/discard outcome) back via
 * addToolResult so the resolution persists across re-render and reload.
 */

import { AlertCircle, X } from 'lucide-react'
import { AnnouncementDraftCard } from './AnnouncementDraftCard'
import { ReplyDraftCard } from './ReplyDraftCard'
import { ModuleDraftCard } from './ModuleDraftCard'
import { DiscussionDraftCard } from './DiscussionDraftCard'
import { ProjectDraftCard } from './ProjectDraftCard'
import { AssignmentDraftCard } from './AssignmentDraftCard'
import { ChallengeDraftCard } from './ChallengeDraftCard'
import { RubricDraftCard } from './RubricDraftCard'
import { FeedbackDraftCard } from './FeedbackDraftCard'
import { DifferentiatedDraftCard } from './DifferentiatedDraftCard'
import { InsightsCard } from './InsightsCard'
import { StudentPerformanceCard } from './StudentPerformanceCard'
import { LiveClassReportCard } from './LiveClassReportCard'
import { OutcomeCoverageCard } from './OutcomeCoverageCard'
import { ResolvedCard, DraftingCard, type DraftToolOutput } from './CardShell'

interface ToolPart {
  type: string
  toolCallId: string
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output?: any
  errorText?: string
}

const DRAFTING_LABELS: Record<string, string> = {
  'tool-draft_discussion': 'Drafting discussion questions…',
  'tool-draft_announcement': 'Writing an announcement…',
  'tool-draft_reply': 'Drafting a reply…',
  'tool-draft_module_outline': 'Outlining a module…',
  'tool-draft_project': 'Drafting a project…',
  'tool-draft_assignment': 'Drafting an assignment…',
  'tool-draft_challenge': 'Drafting a challenge…',
  'tool-draft_rubric': 'Drafting a rubric…',
  'tool-draft_feedback': 'Drafting feedback…',
  'tool-draft_differentiated_version': 'Adapting the content…',
  'tool-ask_course_insights': 'Looking at your course…',
  'tool-get_student_performance': 'Looking up the student…',
  'tool-get_live_class_report': 'Pulling the live-class report…',
  'tool-show_outcome_coverage': 'Pulling the outcome coverage…',
}

const RESOLVED_TITLES: Record<string, string> = {
  'tool-draft_discussion': 'discussion',
  'tool-draft_announcement': 'announcement',
  'tool-draft_reply': 'reply',
  'tool-draft_module_outline': 'module',
  'tool-draft_project': 'project',
  'tool-draft_assignment': 'assignment',
  'tool-draft_challenge': 'challenge',
  'tool-draft_rubric': 'rubric',
  'tool-draft_feedback': 'feedback',
  'tool-draft_differentiated_version': 'version',
}

export function DraftCardRouter({
  part,
  sectionId,
  addToolResult,
}: {
  part: ToolPart
  sectionId: string
  addToolResult: (args: { tool: string; toolCallId: string; output: unknown }) => void
}) {
  const toolName = part.type.replace(/^tool-/, '')

  if (part.state === 'output-error') {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-destructive/30 bg-destructive-muted px-4 py-3 text-sm text-destructive-muted-foreground">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Couldn&apos;t complete that. Try rephrasing your request.</span>
      </div>
    )
  }

  // Read-only insights tool (server execute): just render the snapshot.
  if (part.type === 'tool-ask_course_insights') {
    if (part.state === 'output-available') return <InsightsCard output={part.output} />
    return <DraftingCard label={DRAFTING_LABELS[part.type]} />
  }

  // Read-only per-student summary (server execute).
  if (part.type === 'tool-get_student_performance') {
    if (part.state === 'output-available') return <StudentPerformanceCard output={part.output} />
    return <DraftingCard label={DRAFTING_LABELS[part.type]} />
  }

  // Read-only live-class quiz report (server execute).
  if (part.type === 'tool-get_live_class_report') {
    if (part.state === 'output-available') return <LiveClassReportCard output={part.output} />
    return <DraftingCard label={DRAFTING_LABELS[part.type]} />
  }

  // Read-only ABET coverage (server execute): compact coverage card.
  if (part.type === 'tool-show_outcome_coverage') {
    if (part.state === 'output-available') return <OutcomeCoverageCard output={part.output} />
    return <DraftingCard label={DRAFTING_LABELS[part.type]} />
  }

  // Draft tools.
  if (part.state === 'input-streaming') {
    return <DraftingCard label={DRAFTING_LABELS[part.type] ?? 'Drafting…'} />
  }

  if (part.state === 'output-available') {
    return <ResolvedCard output={part.output as DraftToolOutput} title={RESOLVED_TITLES[part.type] ?? 'draft'} />
  }

  // input-available → editable card.
  // Send the outcome back to the model with an explicit, unambiguous summary so
  // it acknowledges correctly (a bare {approved:false} was being misread as
  // "still pending"). approved/note/href pass through for the resolved card UI.
  const onResolve = (output: DraftToolOutput) =>
    addToolResult({
      tool: toolName,
      toolCallId: part.toolCallId,
      output: {
        ...output,
        summary: output.approved
          ? `The professor APPROVED this draft and it was saved${output.note ? ` — ${output.note}` : '.'} Acknowledge briefly; do not recreate it.`
          : 'The professor DISCARDED this draft. Nothing was saved. Acknowledge briefly and do not recreate it unless they ask again.',
      },
    })

  /* Retired tool: 16 sandbox conversations still hold unresolved `draft_quiz`
     parts from before quizzes moved to the Quiz Studio. Without this case they
     fall through to `default: return null` — an invisible card the professor can
     neither approve nor discard, so the part stays `input-available` forever and
     the route keeps re-injecting "call draft_quiz again" on every later turn.
     Render a terminal notice instead, so the thread reads as finished. */
  if (part.type === 'tool-draft_quiz') {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        <X className="h-4 w-4 shrink-0" aria-hidden />
        <span>Quizzes moved to the Quiz Studio — this draft was discarded.</span>
      </div>
    )
  }

  switch (part.type) {
    case 'tool-draft_discussion':
      return <DiscussionDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    case 'tool-draft_announcement':
      return <AnnouncementDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    case 'tool-draft_reply':
      return <ReplyDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    case 'tool-draft_module_outline':
      return <ModuleDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    case 'tool-draft_project':
      return <ProjectDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    case 'tool-draft_assignment':
      return <AssignmentDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    case 'tool-draft_challenge':
      return <ChallengeDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    case 'tool-draft_rubric':
      return <RubricDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    case 'tool-draft_feedback':
      return <FeedbackDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    case 'tool-draft_differentiated_version':
      return <DifferentiatedDraftCard input={part.input} sectionId={sectionId} onResolve={onResolve} />
    default:
      return null
  }
}
