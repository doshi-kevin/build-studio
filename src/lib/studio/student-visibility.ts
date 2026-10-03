/**
 * Showing an installation to a section's students, and hiding it again.
 *
 * Version publication and student visibility are different things. Publishing a version
 * freezes a code release for its owner's Studio. Showing an installation lets one
 * section's students open it, on whatever version is current there (always approved).
 *
 * reviewVersionForStudents is the one review of a version for students: showing a tool
 * runs it with the installation's own checks, and switching the version of a tool
 * students already see (lifecycle.ts: Use this version, Roll back) runs it alone.
 *
 * Every hard blocker below is checked here, on the server, every time: a confirmation
 * dialog is never the boundary. The database then re-checks the parts it can hold on its
 * own (active installation, same section, actor's institution) under a row lock.
 * Hiding has no blockers beyond being the section's professor: it only reduces what
 * students can reach, so it works even when Studio is switched off or the school has
 * lost the entitlement.
 *
 * Plain server module, not 'use server'. Callers are future server actions.
 */
import 'server-only'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { logEvent } from '@/lib/supabase/event-logger'
import { STUDIO_PAUSED, studentAccessReleased, studioAccess } from './access'
import { requireProfessor, type StudioProfessor } from './context'
import * as db from './db'
import { STUDIO_QUOTA_WARNING_RATIO } from './limits'
import { parseManifest } from './manifest'
import { disclosureNote } from './builder/course-material'
import { loadGuardSources } from './builder/course-retriever'
import { buildPluginCard, type PluginCard } from './plugin-card'
import { prePublishVerdict } from './prepublish'
import { skillBindingIssues } from './skill-bindings'
import { validationSummary, type ValidationSummary } from './validator/service'
import { isSupportedRuntime } from './runtime/protocol'

export const VISIBILITY_NOT_AVAILABLE = 'This isn’t available.'

export type BlockerCode =
  | 'kill_switch'
  | 'release_gate'
  | 'not_entitled'
  | 'not_active'
  | 'section_archived'
  | 'version_missing'
  | 'version_mismatch'
  | 'manifest_invalid'
  | 'manifest_v1'
  | 'bridge_unsupported'
  | 'student_bundle_missing'
  | 'validator_unavailable'
  | 'validator_failed'
  | 'validator_review'
  | 'skill_binding_missing'
  | 'over_quota'
  | 'quota_unavailable'

export type WarningCode = 'near_quota' | 'newer_version' | 'duplicate_label' | 'unreleased_material'

/** One piece of course material students can't see yet, for the unreleased_material warning. */
export interface UnreleasedSource {
  label: string
  /** ISO time it opens to students; null when it has no date (hidden or unpublished). */
  opensAt: string | null
  note: string
}

export interface Issue<C extends string> {
  code: C
  /** Plain language for the professor. Never shown to anyone else. */
  message: string
  /** unreleased_material only: each source the version's builder read that students can't see. */
  sources?: UnreleasedSource[]
}

export interface PublicationReview {
  blockers: Issue<BlockerCode>[]
  warnings: Issue<WarningCode>[]
}

export type VisibilityResult =
  | { ok: true; value: { changed: boolean } }
  | { ok: false; error: string; blockers?: Issue<BlockerCode>[]; warnings?: Issue<WarningCode>[] }

const VERSION_UNUSABLE = 'This tool’s current version can’t be used. Publish a new version and try again.'

const denied = (): { ok: false; error: string } => ({ ok: false, error: VISIBILITY_NOT_AVAILABLE })

const input = z.strictObject({ sectionId: z.uuid(), installationId: z.uuid() })
const showInput = input.extend({ acknowledgeWarnings: z.boolean().optional() })

/**
 * Every check of one version for students, whether it is being shown or becoming the
 * version students already see: the version and manifest, the validator's verdict, skill
 * bindings, and course material its builder read that students can't see yet (a warning,
 * acknowledged). `professorId` labels that material as the professor may see it.
 */
export async function reviewVersionForStudents(
  installation: db.InstallationRow,
  versionId: string,
  professorId: string,
): Promise<PublicationReview> {
  const blockers: Issue<BlockerCode>[] = []
  const warnings: Issue<WarningCode>[] = []
  const block = (code: BlockerCode, message: string) => blockers.push({ code, message })

  const version = await db.loadVersion(versionId)
  if (!version) {
    block('version_missing', VERSION_UNUSABLE)
    return { blockers, warnings }
  }
  if (version.projectId !== installation.projectId || version.institutionId !== installation.institutionId) {
    block('version_mismatch', VERSION_UNUSABLE)
  }
  const manifest = parseManifest(version.manifest)
  if (!manifest.ok) block('manifest_invalid', VERSION_UNUSABLE)
  else if (manifest.manifest.manifestVersion === 1) {
    block('manifest_v1', 'This version was made with an older Studio format. Save a new version from the builder to use it with students.')
  }
  if (!isSupportedRuntime(version.bridgeVersion)) {
    block('bridge_unsupported', 'This tool was built for an older version of Studio. Rebuild it to show it to students.')
  }
  const [bundle, verdict, material] = await Promise.all([
    db.loadVersionBundle(version.id, 'student'),
    prePublishVerdict(version.id),
    unreleasedMaterial(installation.institutionId, version.id, professorId),
  ])
  if (!bundle || bundle.code.trim().length === 0) block('student_bundle_missing', 'This tool has no student view to show.')

  if (verdict.status === 'unavailable') {
    block(
      'validator_unavailable',
      verdict.reason === 'checking'
        ? 'Studio’s automatic checks are still running.'
        : verdict.reason === 'runtime_not_checked'
          ? 'Run the browser checks before students can see this tool.'
          : verdict.reason === 'runtime_error'
            ? 'The browser checks didn’t finish. Run them again.'
            : verdict.reason === 'below_minimum_ruleset'
              ? 'Studio’s checks were updated. This tool is being re-checked.'
              : 'Studio’s automatic checks haven’t passed for this version yet.',
    )
  } else if (verdict.status === 'failed') {
    block('validator_failed', 'This tool didn’t pass Studio’s automatic checks. Fix what’s listed under Studio’s automatic checks, then publish a new version.')
  } else if (verdict.status === 'needs_review') {
    block('validator_review', 'Waiting for a Scholera reviewer. You don’t need to do anything until they decide.')
  }

  if (manifest.ok) {
    const bindings = await skillBindingIssues(installation, manifest.manifest)
    if (!bindings.ok) {
      block(
        'skill_binding_missing',
        'unbound' in bindings
          ? `Link each skill slot to one of this course’s skills: ${bindings.unbound.join(', ')}.`
          : 'Skill links couldn’t be checked. Try again in a moment.',
      )
    }
  }
  if (material) warnings.push(material)
  return { blockers, warnings }
}

/**
 * The unreleased_material warning for a version, or null when everything its builder read
 * is visible to students. Material is read as it is now, not as it was at Save: something
 * released since then no longer warns, and something hidden since then does. When the
 * provenance can't be read, the warning says so rather than staying silent.
 */
async function unreleasedMaterial(institutionId: string, versionId: string, professorId: string): Promise<Issue<'unreleased_material'> | null> {
  const unreadable = {
    code: 'unreleased_material' as const,
    message: 'Studio couldn’t check which course material Athena read for this version. Make sure the tool doesn’t give away anything students shouldn’t see yet.',
  }
  const stored = await db.loadVersionMaterial(versionId)
  if (!stored) return unreadable
  if (stored.sources.length === 0 && !stored.incomplete) return null
  const roster = await db.loadOwnerRosterFullNames(professorId)
  const current = roster === null ? null : await loadGuardSources(institutionId, stored.sources, roster, professorId)
  if (!current) return unreadable
  const sources = current
    .filter((c) => c.disclosure !== 'released')
    .map((c) => ({ label: c.label, opensAt: c.opensAt, note: disclosureNote({ disclosure: 'scheduled', opensAt: c.opensAt }) }))
  if (sources.length === 0 && !stored.incomplete) return null
  const more = stored.incomplete ? ' Athena read more material than Studio can list here, so this list may be incomplete.' : ''
  return {
    code: 'unreleased_material',
    message:
      sources.length > 0
        ? `While building this version, Athena read course material students can’t see yet. Make sure the tool doesn’t give it away early.${more}`
        : `Athena read more course material than Studio can list for this version. Make sure the tool doesn’t give away anything students shouldn’t see yet.`,
    sources,
  }
}

/** Every hard blocker and warning for showing this installation to students: the
 * installation's own checks plus the version review above. The caller has already
 * verified the professor and that the installation is in their section. Checks are all
 * run, so the professor sees everything at once. */
async function reviewPublication(
  professor: StudioProfessor,
  installation: db.InstallationRow,
): Promise<PublicationReview> {
  const blockers: Issue<BlockerCode>[] = []
  const warnings: Issue<WarningCode>[] = []
  const block = (code: BlockerCode, message: string) => blockers.push({ code, message })

  const [access, section, version, usage, limits, versionReview] = await Promise.all([
    studioAccess(professor.institutionId),
    db.loadSectionState(installation.sectionId),
    db.loadVersion(installation.currentVersionId),
    db.loadUsage(installation.id),
    db.loadQuotaLimits(),
    reviewVersionForStudents(installation, installation.currentVersionId, professor.userId),
  ])

  if (access === 'off') block('kill_switch', STUDIO_PAUSED)
  if (!studentAccessReleased()) block('release_gate', 'Showing tools to students isn’t available yet.')
  if (access === 'read_only') block('not_entitled', entitlementRefusalMessage('studio'))
  if (installation.status !== 'active') block('not_active', 'This tool has been removed from the course, so it can’t be shown to students.')
  if (!section || section.archived) block('section_archived', 'This course is archived, so nothing new can be shown to students.')
  blockers.push(...versionReview.blockers)
  warnings.push(...versionReview.warnings)

  if (version) {
    const manifest = parseManifest(version.manifest)
    const latest = await db.loadLatestProjectVersion(installation.projectId)
    if (latest && latest.id !== version.id) {
      warnings.push({ code: 'newer_version', message: 'A newer version of this tool is published but not active in this course.' })
    }
    if (manifest.ok) {
      const siblings = await db.listSectionInstallations(installation.sectionId, { status: 'active', onlyVisible: true })
      if (siblings.some((s) => s.id !== installation.id && s.name === manifest.manifest.name)) {
        warnings.push({ code: 'duplicate_label', message: 'Students already see another tool with this name in this course.' })
      }
    }
  }

  if (!limits) {
    // The database refuses every write without its limits; don't show students a tool
    // that can't save.
    block('quota_unavailable', 'Storage limits couldn’t be checked. Try again in a moment.')
  } else if (usage) {
    if (usage.records >= limits.installationMaxRecords || usage.bytes >= limits.installationMaxBytes) {
      block('over_quota', 'This tool’s storage is full, so students couldn’t save anything.')
    } else if (
      usage.records >= limits.installationMaxRecords * STUDIO_QUOTA_WARNING_RATIO ||
      usage.bytes >= limits.installationMaxBytes * STUDIO_QUOTA_WARNING_RATIO
    ) {
      warnings.push({ code: 'near_quota', message: 'This tool has used most of its storage. Students may run out of space.' })
    }
  }

  return { blockers, warnings }
}

/** The installation, only if it's in the professor's section. */
async function sectionInstallation(professor: StudioProfessor, installationId: string) {
  const installation = await db.loadInstallation(installationId)
  return installation && installation.sectionId === professor.sectionId ? installation : null
}

function audit(professor: StudioProfessor, eventType: string, metadata: Record<string, string>) {
  logEvent({ userId: professor.userId, eventType, eventCategory: 'studio', sectionId: professor.sectionId, metadata })
}

function refreshNavigation(sectionId: string) {
  revalidatePath(`/professor/courses/${sectionId}`, 'layout')
  revalidatePath(`/student/courses/${sectionId}`, 'layout')
}

export interface PublicationPanel extends PublicationReview {
  status: 'active' | 'archived'
  visibility: 'hidden' | 'visible'
  /** The current version's plugin card, or null if its manifest no longer parses. */
  card: PluginCard | null
  /** Published versions of this plugin, newest first, for the preview picker. */
  versions: { id: string; version: string }[]
  /** What Studio's automatic checks found for the current version. */
  validation: ValidationSummary | null
  /** Manifest v2 skill slots, with what each is bound to, and the course's skills. */
  skillSlots: { key: string; label: string; skillId: string | null }[]
  /** Null when the course's skills couldn't be read. */
  sectionSkills: { id: string; name: string }[] | null
}

/** Everything the professor's runtime page shows about publication, read-only. The
 * same checks showToStudents runs; showToStudents runs them again on submit. */
export async function getPublicationPanel(
  raw: z.input<typeof input>,
): Promise<{ ok: true; value: PublicationPanel } | { ok: false; error: string }> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const installation = await sectionInstallation(professor, parsed.data.installationId)
  if (!installation) return denied()

  const [review, version, usage, limits, versions, validation, bindings, sectionSkills] = await Promise.all([
    reviewPublication(professor, installation),
    db.loadVersion(installation.currentVersionId),
    db.loadUsage(installation.id),
    db.loadQuotaLimits(),
    db.listProjectVersions(installation.projectId),
    validationSummary(installation.currentVersionId),
    db.listSkillBindings(installation.id),
    db.listBindableSkills(installation.sectionId),
  ])
  const manifest = version ? parseManifest(version.manifest) : null
  const boundTo = new Map((bindings ?? []).map((b) => [b.slotKey, b.skillId]))
  const slots =
    manifest?.ok && manifest.manifest.manifestVersion === 2
      ? manifest.manifest.skillSlots.map((slot) => ({ key: slot.key, label: slot.label, skillId: boundTo.get(slot.key) ?? null }))
      : []
  const storage = usage && limits ? { ...usage, ...limits } : null
  return {
    ok: true,
    value: {
      ...review,
      status: installation.status,
      visibility: installation.studentVisibility,
      card: manifest?.ok ? buildPluginCard(manifest.manifest, storage) : null,
      versions: versions.map((v) => ({ id: v.id, version: v.version })),
      validation,
      skillSlots: slots,
      sectionSkills: slots.length > 0 ? sectionSkills : [],
    },
  }
}

export async function showToStudents(raw: z.input<typeof showInput>): Promise<VisibilityResult> {
  const parsed = showInput.safeParse(raw)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const installation = await sectionInstallation(professor, parsed.data.installationId)
  if (!installation) return denied()

  const review = await reviewPublication(professor, installation)
  if (review.blockers.length > 0) {
    // For support: which checks refused, by code. No manifest or record contents.
    audit(professor, 'studio.installation.show_blocked', {
      installationId: installation.id,
      versionId: installation.currentVersionId,
      blockers: review.blockers.map((b) => b.code).join(','),
    })
    return { ok: false, error: review.blockers[0].message, blockers: review.blockers, warnings: review.warnings }
  }
  if (review.warnings.length > 0 && !parsed.data.acknowledgeWarnings) {
    return { ok: false, error: 'Read the warnings before showing this tool to students.', warnings: review.warnings }
  }

  // The database refuses if another version became active since the review above.
  const changed = await db.setStudentVisibility(installation.id, professor.sectionId, 'visible', professor.userId, installation.currentVersionId)
  if (!changed.ok) {
    // The database's own re-checks: archived, or a version switched, between the review and the write.
    if (/archived installation/.test(changed.error.message)) {
      return { ok: false, error: 'This tool has been removed from the course, so it can’t be shown to students.' }
    }
    if (/changed while it was being checked/.test(changed.error.message)) {
      return { ok: false, error: 'This tool changed while it was being checked. Try again.' }
    }
    return { ok: false, error: 'Something went wrong. Try again.' }
  }
  if (changed.value) {
    audit(professor, 'studio.installation.shown', { installationId: installation.id, versionId: installation.currentVersionId })
    refreshNavigation(professor.sectionId)
  }
  return { ok: true, value: { changed: changed.value } }
}

/** Always allowed for the section's professor: it only reduces what students reach. */
export async function hideFromStudents(raw: z.input<typeof input>): Promise<VisibilityResult> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const installation = await sectionInstallation(professor, parsed.data.installationId)
  if (!installation) return denied()

  const changed = await db.setStudentVisibility(installation.id, professor.sectionId, 'hidden', professor.userId)
  if (!changed.ok) return { ok: false, error: 'Something went wrong. Try again.' }
  if (changed.value) {
    audit(professor, 'studio.installation.hidden', { installationId: installation.id })
    refreshNavigation(professor.sectionId)
  }
  return { ok: true, value: { changed: changed.value } }
}
