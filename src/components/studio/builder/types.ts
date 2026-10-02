import type { DraftSummary, ConversationTurn, ProgressRead } from '@/lib/studio/builder/service'

export type ViewMode = 'professor' | 'student' | 'split'

export type Device = 'desktop' | 'phone'

export type { DraftSummary, ConversationTurn, ProgressRead }

/** The project open in the builder. */
export interface OpenProject {
  pluginProjectId: string
  name: string
  /** The saved draft the preview shows when no build has produced a newer one. */
  headHash: string | null
}

export const ACTIVE_STATUSES = ['queued', 'running', 'waiting_for_approval', 'waiting_for_professor'] as const

/** Badge copy for a build's status, on the tool cards and in the builder header. */
export const STATUS_BADGE: Partial<Record<ProgressRead['status'], string>> = {
  queued: 'Building',
  running: 'Building',
  waiting_for_approval: 'Needs your approval',
  waiting_for_professor: 'Athena has a question',
  preview_ready: 'Ready to preview',
}

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
