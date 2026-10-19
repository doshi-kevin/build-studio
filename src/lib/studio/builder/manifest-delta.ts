/**
 * The only path to a plugin's manifest from the builder (`propose_manifest_change`). Pure.
 *
 * The manifest is a plugin's whole escalation surface: what each view may ask the Bridge
 * for, what it stores and who reads it, what it tracks. So a proposal is never written as
 * a file. It goes through these steps, in order, and the first refusal stops it:
 *
 *   1. parse the JSON                      not an object        -> manifest_invalid
 *   2. character rule on every string      NUL, controls, bidi  -> bad_characters
 *   3. stamp the fields Scholera owns      id, version, manifestVersion, bridgeVersion, entries
 *   4. parseManifest (version 2)           path-level issues    -> manifest_invalid
 *   5. availability and compatibility      capability without a Bridge method -> capability_unavailable
 *                                          published collection changed       -> collection_frozen
 *   6. purpose wording                     deterministicPurpose -> purpose_flagged
 *   7. diff against the current manifest and classify every change: approval or direct
 *
 * Approval items are built only from fixed tables and regex-limited keys. Model-written
 * text never appears on an approval card.
 */
import { CAPABILITIES, type CapabilityName, type PluginView } from '../capabilities'
import { METHOD_CATALOG } from '../bridge/catalog'
import { PURPOSE_CATEGORIES, SIGNALS, type PurposeCategory, type SignalName } from '../edtech'
import { STUDIO_BUILDER_MANIFEST_MAX_BYTES } from '../limits'
import { parseManifest, type StudioManifest, type StudioManifestV2 } from '../manifest'
import { deterministicPurpose } from '../validator/purpose'
import { canonicalJson } from '../validator/artifact'
import { characterProblem, PLUGIN_PATHS, SERVER_ENTRY, stringsIn, utf8Bytes } from './paths'
import { contentHash } from './snapshot'

/** The version a draft carries. The real one is chosen when the professor saves it. */
export const DRAFT_VERSION = '0.0.0'

/** Capabilities a plugin can actually use: at least one Bridge method needs them. */
export const AVAILABLE_CAPABILITIES: CapabilityName[] = [
  ...new Set(Object.values(METHOD_CATALOG).flatMap((m): CapabilityName[] => (m.capability === null ? [] : [m.capability]))),
]

export type ApprovalKind =
  | 'capability_added' | 'signal_added' | 'collection_added' | 'collection_access_changed'
  | 'skill_slot_added' | 'purpose_changed' | 'audience_changed' | 'server_action_added' | 'server_action_changed'
export type DirectKind =
  | 'renamed' | 'description_changed' | 'summary_changed' | 'capability_removed' | 'signal_removed'
  | 'collection_removed' | 'collection_fields_changed' | 'skill_slot_removed' | 'skill_slot_relabelled' | 'ai_fallback_changed'
  | 'server_action_removed' | 'server_action_args_changed'

export interface DeltaItem<K extends string = ApprovalKind | DirectKind> {
  kind: K
  line: string
}

export type ProposalRefusal = 'manifest_invalid' | 'bad_characters' | 'capability_unavailable' | 'collection_frozen' | 'purpose_flagged'

export type ProposalResult =
  | { ok: false; code: ProposalRefusal; issues: string[] }
  | {
      ok: true
      manifest: StudioManifestV2
      /** Owned fields the proposal tried to set differently; it should stop sending them. */
      stamped: string[]
      approval: DeltaItem<ApprovalKind>[]
      direct: DeltaItem<DirectKind>[]
      /** False when the proposal equals the current manifest. */
      changed: boolean
    }

export interface ProposalContext {
  slug: string
  /** The working copy's manifest; null before the first proposal of a first build. */
  current: StudioManifestV2 | null
  /** The latest published version's manifest, whose collections are frozen. */
  published: StudioManifest | null
}

/** Every top-level field, classified. A new manifest field fails to compile until it is. */
const FIELD_CLASS: Record<keyof StudioManifestV2, 'owned' | 'diffed'> = {
  manifestVersion: 'owned',
  id: 'owned',
  version: 'owned',
  bridgeVersion: 'owned',
  views: 'diffed',
  name: 'diffed',
  description: 'diffed',
  collections: 'diffed',
  purpose: 'diffed',
  signals: 'diffed',
  skillSlots: 'diffed',
  aiFallback: 'diffed',
  server: 'diffed',
}
void FIELD_CLASS

type Access = StudioManifestV2['collections'][string]['access']
/** Fixed plain words for each access mode. The modes form no order, so every change needs approval. */
const ACCESS_LABEL: Record<Access, string> = {
  perStudent: 'each student sees only their own, staff see all',
  staffPerStudent: 'staff record something for each student, each student sees only their own',
  shared: 'staff write, everyone in the section reads',
  staffOnly: 'staff only, never sent to a student’s screen',
}
const AUDIENCE_LABEL: Record<StudioManifestV2['purpose']['audience'], string> = {
  students: 'for students',
  staff: 'for course staff',
  both: 'for students and staff',
}
const VIEW_LABEL: Record<PluginView, string> = { student: 'Student view', professor: 'Your view' }
const CALLER_LABEL: Record<PluginView, string> = { student: 'students', professor: 'you and your TAs' }
const SERVER_ACCESS_LABEL: Record<Access, string> = {
  perStudent: 'recorded by the tool’s own code, each student sees only theirs, staff see all',
  staffPerStudent: 'recorded by the tool’s own code for each student, each student sees only their own',
  shared: 'recorded by the tool’s own code, everyone in the section reads',
  staffOnly: 'recorded by the tool’s own code, staff only, never sent to a student’s screen',
}
const accessLine = (c: { access: Access; writes?: 'server' }) => (c.writes === 'server' ? SERVER_ACCESS_LABEL[c.access] : ACCESS_LABEL[c.access])

/** "peerReviews" -> "peer reviews". Keys are regex-limited identifiers, never free text. */
const humanize = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()

const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)

export function proposeManifest(manifestJson: string, ctx: ProposalContext): ProposalResult {
  // 1. Parse.
  if (utf8Bytes(manifestJson) > STUDIO_BUILDER_MANIFEST_MAX_BYTES) {
    return { ok: false, code: 'manifest_invalid', issues: [`The manifest is larger than ${STUDIO_BUILDER_MANIFEST_MAX_BYTES} bytes.`] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(manifestJson)
  } catch {
    return { ok: false, code: 'manifest_invalid', issues: ['manifest_json is not valid JSON.'] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'manifest_invalid', issues: ['manifest_json must be a JSON object.'] }
  }

  // 2. Characters, in keys and values alike.
  for (const s of stringsIn(raw)) {
    const problem = characterProblem(s)
    if (problem) return { ok: false, code: 'bad_characters', issues: [`The manifest contains ${problem}.`] }
  }

  // 3. Stamp. Rebuilt into a fresh object; a "__proto__" key is an own key after
  // JSON.parse and parseManifest's raw-key checks see it.
  const input = raw as Record<string, unknown>
  const owned: Record<string, unknown> = { manifestVersion: 2, id: ctx.slug, version: DRAFT_VERSION, bridgeVersion: 'v2' }
  const stamped = Object.keys(owned).filter((k) => Object.hasOwn(input, k) && !sameJson(input[k], owned[k]))
  const views = (input.views && typeof input.views === 'object' && !Array.isArray(input.views) ? input.views : {}) as Record<string, unknown>
  const stampedViews: Record<string, unknown> = {}
  for (const path of PLUGIN_PATHS) {
    const view = path === 'views/student.tsx' ? 'student' : 'professor'
    const given = views[view] && typeof views[view] === 'object' && !Array.isArray(views[view]) ? (views[view] as Record<string, unknown>) : {}
    if (Object.hasOwn(given, 'entry') && given.entry !== path) stamped.push(`views.${view}.entry`)
    stampedViews[view] = { capabilities: [], ...given, entry: path }
  }
  // The server entry is fixed like the view entries.
  const server = input.server && typeof input.server === 'object' && !Array.isArray(input.server) ? (input.server as Record<string, unknown>) : null
  if (server && Object.hasOwn(server, 'entry') && server.entry !== SERVER_ENTRY) stamped.push('server.entry')
  const candidate = { ...input, ...owned, views: stampedViews, ...(server ? { server: { ...server, entry: SERVER_ENTRY } } : {}) }

  // 4. The contract.
  const parsed = parseManifest(candidate)
  if (!parsed.ok) return { ok: false, code: 'manifest_invalid', issues: parsed.issues.slice(0, 20) }
  if (parsed.manifest.manifestVersion !== 2) return { ok: false, code: 'manifest_invalid', issues: ['manifestVersion: Must be 2'] }
  const manifest = parsed.manifest

  // 5. Availability and compatibility.
  for (const view of ['student', 'professor'] as const) {
    for (const c of manifest.views[view].capabilities) {
      if (!AVAILABLE_CAPABILITIES.includes(c)) {
        return { ok: false, code: 'capability_unavailable', issues: [`${c} isn’t available to tools yet.`] }
      }
    }
  }
  if (ctx.published) {
    for (const [name, collection] of Object.entries(ctx.published.collections)) {
      if (!Object.hasOwn(manifest.collections, name) || !sameJson(manifest.collections[name], collection)) {
        return {
          ok: false,
          code: 'collection_frozen',
          issues: [`The published collection "${name}" can’t change or be removed. Add a new collection instead.`],
        }
      }
    }
  }

  // 6. Purpose wording.
  const purpose = deterministicPurpose(manifest)
  if (purpose.reasons.length > 0) return { ok: false, code: 'purpose_flagged', issues: purpose.reasons }

  // 7. Diff and classify.
  const { approval, direct } = classify(ctx.current, manifest)
  return { ok: true, manifest, stamped, approval, direct, changed: ctx.current === null || !sameJson(ctx.current, manifest) }
}

/** Every change between two manifests, as approval or direct items. */
export function classify(
  before: StudioManifestV2 | null,
  after: StudioManifestV2,
): { approval: DeltaItem<ApprovalKind>[]; direct: DeltaItem<DirectKind>[] } {
  const approval: DeltaItem<ApprovalKind>[] = []
  const direct: DeltaItem<DirectKind>[] = []

  // Capabilities are granted per view: one the professor view had is still new to the student view.
  for (const view of ['student', 'professor'] as const) {
    const had = new Set<string>(before?.views[view].capabilities ?? [])
    const has = new Set<string>(after.views[view].capabilities)
    for (const c of after.views[view].capabilities) {
      if (!had.has(c)) approval.push({ kind: 'capability_added', line: `${VIEW_LABEL[view]}: ${CAPABILITIES[c].label}` })
    }
    for (const c of had) {
      if (!has.has(c)) direct.push({ kind: 'capability_removed', line: `${VIEW_LABEL[view]} no longer: ${CAPABILITIES[c as CapabilityName].label}` })
    }
  }

  const hadSignals = new Set<SignalName>(before?.signals ?? [])
  for (const s of after.signals) if (!hadSignals.has(s)) approval.push({ kind: 'signal_added', line: `Track: ${SIGNALS[s]}` })
  for (const s of hadSignals) if (!after.signals.includes(s)) direct.push({ kind: 'signal_removed', line: `No longer tracks: ${SIGNALS[s]}` })

  const beforeCollections = before?.collections ?? {}
  for (const [name, c] of Object.entries(after.collections)) {
    const old = Object.hasOwn(beforeCollections, name) ? beforeCollections[name] : null
    const fields = Object.entries(c.fields).map(([f, t]) => `${humanize(f)} (${t})`).join(', ')
    if (!old) {
      approval.push({ kind: 'collection_added', line: `Store "${humanize(name)}": ${accessLine(c)}. Fields: ${fields}` })
      continue
    }
    if (old.access !== c.access || old.writes !== c.writes) {
      approval.push({
        kind: 'collection_access_changed',
        line: `Change who can see or record "${humanize(name)}": from ${accessLine(old)} to ${accessLine(c)}`,
      })
    }
    if (!sameJson(old.fields, c.fields)) direct.push({ kind: 'collection_fields_changed', line: `"${humanize(name)}" now stores: ${fields}` })
  }
  for (const name of Object.keys(beforeCollections)) {
    if (!Object.hasOwn(after.collections, name)) direct.push({ kind: 'collection_removed', line: `No longer stores "${humanize(name)}"` })
  }

  const beforeSlots = new Map((before?.skillSlots ?? []).map((s) => [s.key, s.label]))
  for (const slot of after.skillSlots) {
    if (!beforeSlots.has(slot.key)) approval.push({ kind: 'skill_slot_added', line: `Count toward a course skill you choose: "${humanize(slot.key)}"` })
    else if (beforeSlots.get(slot.key) !== slot.label) direct.push({ kind: 'skill_slot_relabelled', line: `Renamed the "${humanize(slot.key)}" skill slot` })
  }
  for (const key of beforeSlots.keys()) {
    if (!after.skillSlots.some((s) => s.key === key)) direct.push({ kind: 'skill_slot_removed', line: `No longer counts toward "${humanize(key)}"` })
  }

  // Server actions: who may run the tool's server code, and which hidden collections it reads for a student.
  const beforeActions = before?.server?.actions ?? {}
  for (const [name, a] of Object.entries(after.server?.actions ?? {})) {
    const callers = a.roles.map((r) => CALLER_LABEL[r]).join(', ')
    const reads = (a.reads ?? []).map((c) => `"${humanize(c)}"`).join(', ')
    const readsLine = reads && a.roles.includes('student') ? `; for a student, it can look at ${reads}, which students never see` : ''
    const old = Object.hasOwn(beforeActions, name) ? beforeActions[name] : null
    if (!old) {
      approval.push({ kind: 'server_action_added', line: `"${humanize(name)}" runs on Scholera’s servers when ${callers} use it${readsLine}` })
      continue
    }
    const newRole = a.roles.some((r) => !old.roles.includes(r))
    const newRead = (a.reads ?? []).some((c) => !(old.reads ?? []).includes(c))
    if (newRole || newRead) approval.push({ kind: 'server_action_changed', line: `"${humanize(name)}" now runs when ${callers} use it${readsLine}` })
    if (!sameJson(old.args, a.args)) direct.push({ kind: 'server_action_args_changed', line: `Server code "${humanize(name)}" takes different input` })
  }
  for (const name of Object.keys(beforeActions)) {
    if (!Object.hasOwn(after.server?.actions ?? {}, name)) direct.push({ kind: 'server_action_removed', line: `No longer has server code "${humanize(name)}"` })
  }

  if (before?.purpose.category !== after.purpose.category) {
    approval.push({ kind: 'purpose_changed', line: `Purpose: ${PURPOSE_CATEGORIES[after.purpose.category as PurposeCategory]}` })
  }
  if (before?.purpose.audience !== after.purpose.audience) {
    approval.push({ kind: 'audience_changed', line: `Audience: ${AUDIENCE_LABEL[after.purpose.audience]}` })
  }
  if (before && before.purpose.summary !== after.purpose.summary) direct.push({ kind: 'summary_changed', line: 'Updated the purpose summary' })
  if (before && before.name !== after.name) direct.push({ kind: 'renamed', line: 'Renamed the tool' })
  if (before && before.description !== after.description) direct.push({ kind: 'description_changed', line: 'Updated the description' })
  if (before && before.aiFallback !== after.aiFallback) direct.push({ kind: 'ai_fallback_changed', line: 'Changed what happens when AI is off' })

  return { approval, direct }
}

/** Binds an approval to one exact transition: from this working revision and manifest to this proposal. */
export function deltaHash(baseWorkRev: number, base: StudioManifestV2 | null, proposed: StudioManifestV2): string {
  return contentHash({ format: 'studio-delta-v1', base_work_rev: baseWorkRev, base: base ?? null, proposed })
}

/** What a professor reads first on an approval card: a few plain sentences, one per kind of new
 * permission, built only from the change's capabilities and access modes (fixed copy, never the
 * model's words). The exact lines stay on the card under a disclosure. */
export function approvalSummary(before: StudioManifest | null, after: StudioManifest): string[] {
  const caps = (m: StudioManifest | null) => new Set(m ? [...m.views.student.capabilities, ...m.views.professor.capabilities] : [])
  const had = caps(before)
  const added = [...caps(after)].filter((c) => !had.has(c))
  const newAccess = new Set(
    Object.entries(after.collections)
      .filter(([name, c]) => before?.collections[name]?.access !== c.access)
      .map(([, c]) => c.access),
  )
  const lines: string[] = []
  if (added.includes('course.roster')) {
    lines.push('Use your class list, so you can work with each student by name. Names stay in Scholera: the tool’s own code only ever gets anonymous IDs.')
  }
  if (newAccess.has('staffPerStudent')) lines.push('Save a record about each student. Each student sees only their own; you and your TAs see everyone’s.')
  if (newAccess.has('perStudent')) lines.push('Let each student save their own work. Each student sees only theirs; you and your TAs see everyone’s.')
  if (newAccess.has('shared')) lines.push('Save content you and your TAs write, which everyone in the course can read.')
  if (newAccess.has('staffOnly')) lines.push('Save notes that only you and your TAs can see.')
  if (added.includes('course.assignments')) lines.push('Read your published assignments and their due dates.')
  if (added.includes('course.skills')) lines.push('Read your course’s skill list.')
  const actions = (m: StudioManifest | null) => (m?.manifestVersion === 2 ? (m.server?.actions ?? {}) : {})
  const beforeActions = actions(before)
  // The same test classify uses: a new action, or one that gains a role or a read.
  const grown = Object.entries(actions(after)).filter(([name, a]) => {
    const old = Object.hasOwn(beforeActions, name) ? beforeActions[name] : null
    return !old || a.roles.some((r) => !old.roles.includes(r)) || (a.reads ?? []).some((c) => !(old.reads ?? []).includes(c))
  })
  if (grown.length > 0) lines.push('Run its own code on Scholera’s servers when it’s used. That code can reach only this tool’s own records and your course’s name and code.')
  if (grown.some(([, a]) => a.roles.includes('student') && (a.reads ?? []).length > 0)) {
    lines.push('When a student uses it, it can read answers or settings students never see, to check their work. The tool’s code decides what the student gets back, so try it in Student view to make sure it doesn’t give answers away.')
  }
  if (Object.entries(after.collections).some(([name, c]) => c.writes === 'server' && before?.collections[name]?.writes !== 'server')) {
    lines.push('Keep results that only the tool’s server code writes, so students can’t change them.')
  }
  return lines
}
