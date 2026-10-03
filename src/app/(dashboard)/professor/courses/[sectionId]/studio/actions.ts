'use server'

/**
 * The professor's Studio builder actions: start a build, stop it, answer Athena's
 * question, approve or decline a manifest change, open a draft preview, save the draft
 * as a version, and undo the last build.
 *
 * Thin on purpose. Every rule lives in the trusted builder service
 * (src/lib/studio/builder/service.ts), which validates the input, verifies the section's
 * professor again, re-binds every id to that professor, checks Studio and the builder's
 * AI switch, calls one database function that re-checks state under a lock, and audits.
 * These actions authenticate, refuse early, call one service, refresh, and return
 * `{ success }` or `{ error }`. Progress is read from GET /api/studio/builder/runs/[runId].
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProfessor } from '@/lib/studio/context'
import {
  addSavedVersionToCourse,
  answerQuestion,
  decideApproval,
  decideMemoryProposal,
  issueDraftPreview,
  listDraftHistory,
  listProjectMemories,
  loadConversation,
  removeProjectMemory,
  saveDraftAsVersion,
  saveProjectMemory,
  startBuild,
  stopBuild,
  undoDraft,
  versionRelease,
  type ConversationTurn,
  type DraftHistory,
  type MemoryItem,
  type VersionRelease,
} from '@/lib/studio/builder/service'
import type { BlockerCode, Issue, WarningCode } from '@/lib/studio/student-visibility'
import type { MemoryKind, MemorySlot, MemoryTopic } from '@/lib/studio/builder/memory'
import type { StudioManifest } from '@/lib/studio/manifest'

const NOT_AVAILABLE = 'This isn’t available.'

/** Signed in, and the section's professor. The service checks both again. */
async function professorOf(sectionId: unknown): Promise<boolean> {
  if (typeof sectionId !== 'string') return false
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return false
  return (await requireProfessor(sectionId)) !== null
}

const refresh = (sectionId: string) => revalidatePath(`/professor/courses/${sectionId}/studio`)

export type StartBuildActionResult =
  | { success: true; runId: string; pluginProjectId: string }
  | { error: string; conflict?: { kind: 'busy' | 'waiting'; runId: string } }

export async function startBuildAction(input: {
  sectionId: string
  pluginProjectId: string | null
  request: string
  clientRequestId: string
  replaceRunId?: string | null
}): Promise<StartBuildActionResult> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await startBuild(input)
  if (!r.ok) return { error: r.error, conflict: r.conflict }
  refresh(input.sectionId)
  return { success: true, ...r.value }
}

export async function stopBuildAction(input: { sectionId: string; runId: string }): Promise<{ success: true } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await stopBuild(input)
  if (!r.ok) return { error: r.error }
  refresh(input.sectionId)
  return { success: true }
}

export async function decideApprovalAction(input: {
  sectionId: string
  runId: string
  proposalId: string
  deltaHash: string
  approve: boolean
}): Promise<{ success: true } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await decideApproval(input)
  return r.ok ? { success: true } : { error: r.error }
}

export async function answerQuestionAction(input: {
  sectionId: string
  runId: string
  questionId: string
  answer: string
}): Promise<{ success: true } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await answerQuestion(input)
  return r.ok ? { success: true } : { error: r.error }
}

export async function loadConversationAction(input: { sectionId: string; pluginProjectId: string }): Promise<{ success: true; turns: ConversationTurn[] } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const turns = await loadConversation(input)
  return turns ? { success: true, turns } : { error: NOT_AVAILABLE }
}

export async function draftPreviewAction(input: {
  sectionId: string
  pluginProjectId: string
  snapshotHash: string
  view: 'student' | 'professor'
}): Promise<{ success: true; frameUrl: string; allowedMethods: string[]; manifest: StudioManifest; title: string } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await issueDraftPreview(input)
  return r.ok ? { success: true, ...r.value } : { error: r.error }
}

export async function saveDraftAsVersionAction(input: {
  sectionId: string
  pluginProjectId: string
  snapshotHash: string
}): Promise<{ success: true; version: string; versionId: string } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await saveDraftAsVersion(input)
  if (!r.ok) return { error: r.error }
  refresh(input.sectionId)
  revalidatePath(`/professor/courses/${input.sectionId}`, 'layout')
  return { success: true, version: r.value.version, versionId: r.value.versionId }
}

/** Where a saved version stands in this course, and its plugin card, for the Save card. */
export async function versionReleaseAction(input: { sectionId: string; versionId: string }): Promise<({ success: true } & VersionRelease) | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await versionRelease(input)
  return r.ok ? { success: true, ...r.value } : { error: r.error }
}

/** Add to this course, or Use this version in the course; Studio's browser checks then
 * start on their own. The services audit both steps. */
export async function addVersionToCourseAction(input: {
  sectionId: string
  versionId: string
  acknowledgeWarnings: boolean
}): Promise<{ success: true; installationId: string; added: boolean; checks: string } | { error: string; blockers?: Issue<BlockerCode>[]; warnings?: Issue<WarningCode>[] }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await addSavedVersionToCourse({ sectionId: input.sectionId, versionId: input.versionId, acknowledgeWarnings: input.acknowledgeWarnings === true })
  if (!r.ok) return { error: r.error, blockers: r.blockers, warnings: r.warnings }
  refresh(input.sectionId)
  revalidatePath(`/professor/courses/${input.sectionId}`, 'layout')
  revalidatePath(`/student/courses/${input.sectionId}`, 'layout')
  revalidatePath(`/professor/courses/${input.sectionId}/studio/${r.value.installationId}`)
  return { success: true, ...r.value }
}

export async function loadDraftHistoryAction(input: { sectionId: string; pluginProjectId: string }): Promise<({ success: true } & DraftHistory) | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const history = await listDraftHistory(input)
  return history ? { success: true, ...history } : { error: NOT_AVAILABLE }
}

export async function loadMemoriesAction(input: { sectionId: string; pluginProjectId: string }): Promise<{ success: true; memories: MemoryItem[] } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const memories = await listProjectMemories(input)
  return memories ? { success: true, memories } : { error: NOT_AVAILABLE }
}

/** The service audits the save (ids and topic, never the words). */
export async function saveMemoryAction(input: {
  sectionId: string
  pluginProjectId: string
  topic: MemoryTopic
  slot: MemorySlot
  kind: MemoryKind
  statement: string
  replaceId: string | null
}): Promise<{ success: true } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await saveProjectMemory(input)
  if (!r.ok) return { error: r.error }
  refresh(input.sectionId)
  return { success: true }
}

export async function removeMemoryAction(input: { sectionId: string; pluginProjectId: string; memoryId: string }): Promise<{ success: true } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await removeProjectMemory(input)
  if (!r.ok) return { error: r.error }
  refresh(input.sectionId)
  return { success: true }
}

export async function decideMemoryAction(input: { sectionId: string; runId: string; memoryId: string; approve: boolean }): Promise<{ success: true } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await decideMemoryProposal(input)
  if (!r.ok) return { error: r.error }
  refresh(input.sectionId)
  return { success: true }
}

/** The service audits the undo (project and both short hashes, no content). */
export async function undoDraftAction(input: {
  sectionId: string
  pluginProjectId: string
  expectedHead: string
  expectedRev: number
}): Promise<{ success: true; headHash: string; rev: number } | { error: string }> {
  if (!(await professorOf(input?.sectionId))) return { error: NOT_AVAILABLE }
  const r = await undoDraft(input)
  if (!r.ok) return { error: r.error }
  refresh(input.sectionId)
  return { success: true, ...r.value }
}
