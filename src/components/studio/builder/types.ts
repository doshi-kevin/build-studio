import type { DraftSummary, ConversationTurn, DraftHistoryEntry, ProgressRead } from '@/lib/studio/builder/service'

export type ViewMode = 'professor' | 'student' | 'split'

export type { DraftSummary, ConversationTurn, DraftHistoryEntry, ProgressRead }

/** The project open in the builder. */
export interface OpenProject {
  pluginProjectId: string
  name: string
  /** The saved draft the preview shows when no build has produced a newer one. */
  headHash: string | null
}

export const ACTIVE_STATUSES = ['queued', 'running', 'waiting_for_approval', 'waiting_for_professor'] as const

/**
 * The compact segmented control from the design system (6.3): a muted track, the chosen
 * item lifted onto a card. For ToggleGroup with spacing={1}, and each ToggleGroupItem.
 */
export const SEGMENTED = 'rounded-xl bg-muted p-1'
export const SEGMENT = 'min-h-11 min-w-11 rounded-xl font-semibold text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm'

export type Tone = 'info' | 'warning' | 'success' | 'neutral' | 'destructive'

/** One name and tone per build status, wherever a status shows: header, chat, tool cards. */
export const RUN_STATUS: Record<ProgressRead['status'], { label: string; tone: Tone }> = {
  queued: { label: 'Building', tone: 'info' },
  running: { label: 'Building', tone: 'info' },
  waiting_for_approval: { label: 'Needs your approval', tone: 'warning' },
  waiting_for_professor: { label: 'Athena has a question', tone: 'warning' },
  preview_ready: { label: 'Draft built', tone: 'success' },
  completed: { label: 'No change needed', tone: 'neutral' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
  failed: { label: 'Didn’t finish', tone: 'destructive' },
  blocked: { label: 'Couldn’t finish', tone: 'destructive' },
  budget_exhausted: { label: 'Hit the build limit', tone: 'warning' },
}

export const TONE_CHIP: Record<Tone, string> = {
  info: 'bg-info-muted text-info-muted-foreground',
  warning: 'bg-warning-muted text-warning-muted-foreground',
  success: 'bg-success-muted text-success-muted-foreground',
  neutral: 'bg-muted text-muted-foreground',
  destructive: 'bg-destructive-muted text-destructive-muted-foreground',
}

/** Runs that ended without changing the draft. Typed wide so `.includes(status)` typechecks. */
export const ENDED_UNBUILT: readonly ProgressRead['status'][] = ['failed', 'blocked', 'cancelled', 'budget_exhausted']

/** What the builder's one status region announces when a build changes state. Fixed copy only. */
const ANNOUNCE: Partial<Record<ProgressRead['status'], string>> = {
  waiting_for_approval: 'Athena needs your approval.',
  waiting_for_professor: 'Athena has a question for you.',
  preview_ready: 'Preview ready.',
  completed: 'Done. Nothing needed to change.',
  cancelled: 'This request stopped. Your tool is unchanged.',
  blocked: 'Athena couldn’t finish this request.',
  budget_exhausted: 'Athena reached the limit for one build.',
  failed: 'Something went wrong. Your tool is unchanged.',
}

/** An ending is news only if this page watched the run work (`sawActive`); a waiting run always is. */
export function statusAnnouncement(status: ProgressRead['status'] | undefined, sawActive: boolean): string {
  if (!status) return ''
  const active = (ACTIVE_STATUSES as readonly string[]).includes(status)
  return active || sawActive ? (ANNOUNCE[status] ?? '') : ''
}
