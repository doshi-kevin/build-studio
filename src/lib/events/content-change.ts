/**
 * Content-change notifications — tell enrolled students when a PUBLISHED assignment or
 * quiz's due date or instructions change (Scholera Pulse). Emitted from the professor
 * edit actions; a no-op unless the item is published and something notable actually
 * changed. Uses emitEvent's 'refresh' mode so repeated edits re-surface one notification
 * rather than piling up or being deduped away.
 */
import { emitEvent } from '@/lib/events/emit'

/** True when two due-date values represent a different instant (null-safe). */
export function dueDatesDiffer(a: string | null, b: string | null): boolean {
  if (!a && !b) return false
  if (!a || !b) return true
  return new Date(a).getTime() !== new Date(b).getTime()
}

interface ContentChangeInput {
  entityKind: 'assignment' | 'quiz'
  sectionId: string
  actorId: string
  entityId: string
  /** Current title, for the notification headline. */
  title: string
  /** Where the student lands. */
  linkUrl: string
  oldDueAt: string | null
  newDueAt: string | null
  /** Instructions/description before + after; omit when this edit can't touch them. */
  oldInstructions?: string | null
  newInstructions?: string | null
  /** Other notable settings changed (e.g. a quiz's time limit / attempts). */
  settingsChanged?: boolean
}

/**
 * Notify enrolled students of a change to a published assignment/quiz. The caller must
 * have already verified professor access AND that the item is PUBLISHED. No-op if nothing
 * notable actually changed. Best-effort (emitEvent never throws).
 */
export async function emitContentChange(input: ContentChangeInput): Promise<void> {
  const dueChanged = dueDatesDiffer(input.oldDueAt, input.newDueAt)
  const instructionsChanged =
    input.oldInstructions !== undefined &&
    (input.oldInstructions ?? '') !== (input.newInstructions ?? '')

  /* Each phrase carries its own grammatical number (#696 part 2). The verb used to be
     chosen by COUNTING phrases, so a single change whose phrase happens to be a plural noun
     produced "The instructions was updated." Two of the three phrases here are plural
     nouns, so counting was wrong more often than it was right. */
  const changed: Array<{ phrase: string; plural: boolean }> = []
  if (dueChanged) changed.push({ phrase: 'the due date', plural: false })
  if (instructionsChanged) changed.push({ phrase: 'the instructions', plural: true })
  if (input.settingsChanged) changed.push({ phrase: 'the settings', plural: true })
  if (changed.length === 0) return

  const label = input.entityKind === 'assignment' ? 'Assignment' : 'Quiz'
  const phrases = changed.map((c) => c.phrase)
  const list =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
  // A joined subject is plural regardless; a lone subject takes its own number.
  const verb = changed.length > 1 || changed[0].plural ? 'were' : 'was'
  const body = `${list.charAt(0).toUpperCase()}${list.slice(1)} ${verb} updated — check the latest.`

  await emitEvent({
    type: input.entityKind === 'assignment' ? 'assignment_updated' : 'quiz_updated',
    sectionId: input.sectionId,
    actorId: input.actorId,
    entity: { type: input.entityKind, id: input.entityId },
    title: `${label} updated: ${input.title}`,
    body,
    linkUrl: input.linkUrl,
    actionable: false,
    dueAt: input.newDueAt,
    onDuplicate: 'refresh',
  })
}
