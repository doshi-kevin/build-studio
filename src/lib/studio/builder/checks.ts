/**
 * The draft gate: everything `run_checks`, the completion gate and Save run on a working
 * copy, in a fixed order the model can't change.
 *
 *   1. compile both views          (check worker)
 *   2. typecheck both views        (check worker, same call)
 *   3. Stage 1 static checks       (the validator's pure engine, on the assembled artifact)
 *   4. builder checks              manifest correctness, purpose wording, sample data that
 *                                  matches the collections, student names, and no copy of
 *                                  course material students can't see yet
 *
 * Stage 1 runs exactly as it does at publish except for two checks: `artifact.hash`
 * (the harness supplies the hash, so it always matches) and `edtech.purpose` (the AI
 * classifier runs at Save, never in the repair loop). Nothing here writes a validation
 * row, calls a model or starts a browser: Stage 2 stays with publication.
 *
 * Passing the gate is not a security property. The sandbox, its policy, the Bridge and
 * the server are the boundary; this gate filters honest mistakes early.
 */
import { CAPABILITIES } from '../capabilities'
import { STUDIO_BUILDER_FINDINGS_MAX, STUDIO_VALIDATOR_FINDINGS_PER_CHECK } from '../limits'
import { parseManifest, type StudioManifest, type StudioManifestV2 } from '../manifest'
import { artifactHash, canonicalJson, type PluginArtifact } from '../validator/artifact'
import { deterministicPurpose } from '../validator/purpose'
import { checkDefinition, requiredCheckIds, STUDIO_VALIDATOR_RULESET, type CheckSeverity, type StaticCheckId } from '../validator/ruleset'
import { quote } from '../validator/scan'
import { runStaticChecks, type CheckStatus } from '../validator/static-checks'
import { findRosterFullName } from '@/lib/validations/memory'
import type { SourceDiagnostic } from './compile'
import { findCopies, type GuardSource } from './disclosure'
import { checkSample, sampleTexts } from './sample-data'
import { AVAILABLE_CAPABILITIES } from './manifest-delta'
import { PLUGIN_PATHS, type PluginPath } from './paths'
import { workHash } from './snapshot'
import type { SampleData } from './work'

export type BuilderCheckId =
  | Exclude<StaticCheckId, 'artifact.hash' | 'edtech.purpose'>
  | 'builder.manifest'
  | 'builder.compile'
  | 'builder.typecheck'
  | 'builder.purpose_text'
  | 'builder.roster'
  | 'builder.disclosure'
  | 'builder.sample'

export type RepairCategory =
  | 'syntax' | 'types' | 'module_shape' | 'kit_usage' | 'styling' | 'required_states' | 'bridge_declaration'
  | 'forbidden_api' | 'manifest' | 'purpose_wording' | 'student_data' | 'size' | 'not_actionable'

export interface BuilderFinding {
  check_id: BuilderCheckId
  severity: CheckSeverity
  /** False: a warning that never blocks. */
  required: boolean
  file: PluginPath | 'manifest' | 'sample' | null
  /** Source lines for compile and typecheck. Null for Stage 1 findings, whose lines index the bundle. */
  line: number | null
  message: string
  /** Quoted evidence, already clamped. Never a student's name. */
  detail: string | null
  category: RepairCategory
  hint: string
}

type StaticBuilderId = Exclude<BuilderCheckId, `builder.${string}`>

/** Every check id the model can see, with its repair category and fixed hint. Exhaustive. */
const GUIDE: Record<BuilderCheckId, { category: RepairCategory; hint: string }> = {
  'builder.manifest': { category: 'manifest', hint: 'Fix the manifest with propose_manifest_change.' },
  'builder.compile': { category: 'syntax', hint: 'Fix the syntax or the imports at that line. Import only named kit members.' },
  'builder.typecheck': { category: 'types', hint: 'Use only names and props the kit declares; call get_kit_reference to check a component.' },
  'builder.purpose_text': { category: 'purpose_wording', hint: 'Reword the manifest name, description or purpose summary plainly, as a description for a professor.' },
  'builder.roster': { category: 'student_data', hint: 'Remove the student’s name. Tools never contain student names; data comes from records at run time.' },
  'builder.disclosure': {
    category: 'student_data',
    hint: 'Students can’t see this course material yet. Use it for the tool’s structure and topics, not its wording, or ask the professor to make it visible first.',
  },
  'builder.sample': { category: 'manifest', hint: 'Rewrite the sample data with write_sample_data so every record matches its collection as the manifest declares it now.' },
  'artifact.size': { category: 'size', hint: 'Make the view smaller.' },
  'artifact.entries': { category: 'module_shape', hint: 'Both views must exist and export a default function.' },
  'artifact.vendor_free': { category: 'module_shape', hint: 'Import React hooks and kit components; never include their code.' },
  'artifact.syntax': { category: 'module_shape', hint: 'The view compiled to something the runtime can’t run. Simplify the code at the reported place.' },
  'source.imports': { category: 'module_shape', hint: 'Import only from "react" and "@scholera/plugin-kit".' },
  'manifest.valid': { category: 'manifest', hint: 'Call propose_manifest_change, or finish blocked if the professor declined it.' },
  'code.navigation': { category: 'forbidden_api', hint: 'Remove the navigation. A tool never leaves its frame or opens pages.' },
  'code.global_indirection': { category: 'forbidden_api', hint: 'Don’t reach browser globals (window, document, parent, top). Use the kit.' },
  'code.html_injection': { category: 'forbidden_api', hint: 'Render text with kit components; never raw HTML.' },
  'code.dynamic_code': { category: 'forbidden_api', hint: 'Remove eval, new Function, string timers and dynamic import.' },
  'code.network': { category: 'forbidden_api', hint: 'Remove direct network calls. Use request and useRequest with declared methods.' },
  'code.storage': { category: 'forbidden_api', hint: 'Save data with records.* through request, never browser storage.' },
  'code.workers': { category: 'forbidden_api', hint: 'Remove the worker.' },
  'code.device_apis': { category: 'forbidden_api', hint: 'Remove the device API. It isn’t available to tools.' },
  'code.bridge_usage': { category: 'bridge_declaration', hint: 'Call only Bridge methods this view’s manifest declares, with the method name as a string literal.' },
  'code.external_urls': { category: 'not_actionable', hint: 'A web address in the code can’t be loaded. Fine if it is shown as text.' },
  'kit.components_only': { category: 'kit_usage', hint: 'Build the screen only from kit components (Screen, Stack, Card, Text...), never HTML elements.' },
  'kit.no_hardcoded_style': { category: 'styling', hint: 'Remove style, className and color values. Use component props and variants.' },
  'kit.required_states': { category: 'required_states', hint: 'Render Loading, Empty and ErrorState in each view, and use each one you import.' },
  'data.answer_key': { category: 'student_data', hint: 'Keep answers out of the student view’s code. Store them in a staffOnly collection.' },
  'edtech.signals': { category: 'manifest', hint: 'Track only signals from the shared list.' },
  'edtech.skill_slots': { category: 'manifest', hint: 'A skill slot names a concept, never a specific skill or id.' },
  'edtech.ai_fallback': { category: 'manifest', hint: 'Set aiFallback to not-applicable: tools don’t use AI yet.' },
}

const BUILDER_SEVERITY: Record<`builder.${string}` & BuilderCheckId, CheckSeverity> = {
  'builder.manifest': 'policy',
  'builder.compile': 'reliability',
  'builder.typecheck': 'reliability',
  'builder.purpose_text': 'policy',
  'builder.roster': 'security',
  'builder.disclosure': 'security',
  'builder.sample': 'reliability',
}

/** Stage 1 checks the draft gate requires: all required static checks but the two above. */
export const DRAFT_REQUIRED = requiredCheckIds('static').filter((id) => id !== 'artifact.hash' && id !== 'edtech.purpose') as StaticBuilderId[]

export type GateStatus = 'passed' | 'failed' | 'not_run'

export interface CheckSummary {
  passed: boolean
  compiler: string | null
  ruleset: number
  compile: GateStatus
  typecheck: GateStatus
  manifest: GateStatus
  purpose_text: GateStatus
  roster: GateStatus | 'unavailable'
  /** Copies of course material students can't see yet. */
  disclosure: GateStatus | 'unavailable'
  static: Partial<Record<StaticBuilderId, CheckStatus | 'not_run'>>
  /** Blocking findings by check and file, at most 10. */
  unresolved: { check_id: BuilderCheckId; file: string | null; count: number }[]
  warnings: { check_id: BuilderCheckId; file: string | null; count: number }[]
}

export interface DraftCheckResult {
  workHash: string
  passed: boolean
  findings: BuilderFinding[]
  /** How many findings existed before the cap. */
  totalFindings: number
  summary: CheckSummary
  /** Present when both views compiled. */
  bundles: { student: string; professor: string } | null
  compiler: string | null
}

export interface WorkerCheckLike {
  compiler: string
  compile: Record<PluginPath, { ok: true; bundle: string } | { ok: false; diagnostics: SourceDiagnostic[] }>
  typecheck: { diagnostics: SourceDiagnostic[]; total: number }
}

export interface DraftCheckDeps {
  /** Compile and typecheck in the check worker. Throws on time, memory or a compiler fault. */
  workerCheck: (files: Record<PluginPath, string>) => Promise<WorkerCheckLike>
  /** Students' full names across the owner's sections. Null: the roster couldn't be read, so the check fails closed. */
  rosterFullNames: readonly string[] | null
  /** The latest published version's manifest; its collections are frozen. */
  published: StudioManifest | null
  /**
   * The current text and disclosure class of every course source the project's builds read
   * (studio_course_sources). Empty when they read none. Null: they couldn't be read, so the
   * check fails closed.
   */
  disclosureSources: readonly GuardSource[] | null
}

const SEVERITY_ORDER: Record<CheckSeverity, number> = { security: 0, reliability: 1, policy: 2, quality: 3 }

function finding(check_id: BuilderCheckId, partial: Omit<BuilderFinding, 'check_id' | 'severity' | 'required' | 'category' | 'hint'> & { required?: boolean }): BuilderFinding {
  const definition = check_id.startsWith('builder.') ? null : checkDefinition(check_id)
  return {
    check_id,
    severity: definition?.severity ?? BUILDER_SEVERITY[check_id as keyof typeof BUILDER_SEVERITY],
    required: partial.required ?? definition?.required ?? true,
    file: partial.file,
    line: partial.line,
    message: partial.message,
    detail: partial.detail,
    category: GUIDE[check_id].category,
    hint: GUIDE[check_id].hint,
  }
}

/** Stage 1 metadata to findings: lines index the bundle, so the source file and a quote locate them. */
function staticFindings(id: StaticBuilderId, status: CheckStatus, message: string, metadata: Record<string, unknown> | undefined): BuilderFinding[] {
  const required = status !== 'warning'
  const listedItems = Array.isArray(metadata?.findings) ? (metadata.findings as { view?: string; detail?: string }[]) : null
  if (listedItems && listedItems.length > 0) {
    return listedItems.slice(0, STUDIO_VALIDATOR_FINDINGS_PER_CHECK).map((f) =>
      finding(id, { required, file: f.view === 'professor' ? 'views/professor.tsx' : 'views/student.tsx', line: null, message, detail: f.detail ? quote(f.detail) : null }),
    )
  }
  const firstOf = (key: string) => (Array.isArray(metadata?.[key]) ? (metadata[key] as unknown[]).map(String)[0] : undefined)
  const detail = firstOf('missing') ?? firstOf('issues') ?? firstOf('imports') ?? firstOf('problems') ?? firstOf('slots')
  const file = id.startsWith('manifest') || id.startsWith('edtech') ? 'manifest' : null
  return [finding(id, { required, file, line: null, message, detail: detail ? quote(detail) : null })]
}

/** Run the whole gate on one working copy. */
export async function runDraftChecks(
  work: { manifest: StudioManifestV2 | null; files: Partial<Record<PluginPath, string>>; sample?: SampleData | null },
  deps: DraftCheckDeps,
): Promise<DraftCheckResult> {
  const findings: BuilderFinding[] = []
  const summary: CheckSummary = {
    passed: false,
    compiler: null,
    ruleset: STUDIO_VALIDATOR_RULESET,
    compile: 'not_run',
    typecheck: 'not_run',
    manifest: 'not_run',
    purpose_text: 'not_run',
    roster: 'not_run',
    disclosure: 'not_run',
    static: {},
    unresolved: [],
    warnings: [],
  }
  const hash = workHash(work.manifest, work.files, work.sample)
  let bundles: DraftCheckResult['bundles'] = null

  // Builder: the manifest is present, valid, available and compatible.
  const manifest = work.manifest
  if (!manifest) {
    summary.manifest = 'failed'
    findings.push(finding('builder.manifest', { file: 'manifest', line: null, message: 'This tool has no manifest yet.', detail: null }))
  } else {
    const issues: string[] = []
    const reparsed = parseManifest(manifest)
    if (!reparsed.ok) issues.push(...reparsed.issues)
    for (const view of ['student', 'professor'] as const) {
      for (const c of manifest.views[view].capabilities) {
        if (!AVAILABLE_CAPABILITIES.includes(c)) issues.push(`${c} isn’t available to tools yet`)
        if (Object.hasOwn(CAPABILITIES, c) && !CAPABILITIES[c].views.includes(view)) issues.push(`${c} isn’t available in the ${view} view`)
      }
    }
    for (const [name, c] of Object.entries(deps.published?.collections ?? {})) {
      if (canonicalJson(manifest.collections[name] ?? null) !== canonicalJson(c)) issues.push(`published collection ${name} changed`)
    }
    summary.manifest = issues.length === 0 ? 'passed' : 'failed'
    for (const issue of issues.slice(0, 5)) findings.push(finding('builder.manifest', { file: 'manifest', line: null, message: 'The manifest isn’t valid for a tool.', detail: quote(issue) }))

    // Builder: purpose wording. Reported as reason codes, never the matched words.
    const purpose = deterministicPurpose(manifest)
    summary.purpose_text = purpose.reasons.length === 0 ? 'passed' : 'failed'
    for (const reason of purpose.reasons) {
      findings.push(finding('builder.purpose_text', { file: 'manifest', line: null, message: 'The manifest’s description of the tool needs another look.', detail: reason }))
    }

    // Builder: sample data still matches the collections (the manifest can change after it).
    if (work.sample) {
      const sample = checkSample(work.sample, manifest)
      if (!sample.ok) {
        for (const issue of sample.issues.slice(0, 3)) findings.push(finding('builder.sample', { file: 'sample', line: null, message: 'The sample data doesn’t match the tool’s collections.', detail: quote(issue) }))
      }
    }
  }

  // Builder: no student's full name anywhere in the tool. Fails closed.
  const texts = [
    ...PLUGIN_PATHS.map((p) => ({ file: p as PluginPath | 'manifest' | 'sample', text: work.files[p] ?? '' })),
    { file: 'manifest' as const, text: manifest ? JSON.stringify(manifest) : '' },
    { file: 'sample' as const, text: sampleTexts(work.sample ?? null).join(' · ') },
  ]
  if (deps.rosterFullNames === null) {
    summary.roster = 'unavailable'
    findings.push(finding('builder.roster', { file: null, line: null, message: 'The student-name check couldn’t run. Don’t change the code for it; checking again retries it.', detail: null }))
  } else {
    const hit = texts.find((t) => findRosterFullName(t.text, deps.rosterFullNames!) !== null)
    summary.roster = hit ? 'failed' : 'passed'
    // The name itself is never quoted: it would land in the prompt and the trajectory.
    if (hit) findings.push(finding('builder.roster', { file: hit.file, line: null, message: 'The tool contains a student’s full name.', detail: null }))
  }

  // Builder: no copy of course material students can't see yet. Fails closed. The finding
  // names the source by its label, never by its text.
  if (deps.disclosureSources === null) {
    summary.disclosure = 'unavailable'
    findings.push(finding('builder.disclosure', { file: null, line: null, message: 'The course-material check couldn’t run. Don’t change the code for it; checking again retries it.', detail: null }))
  } else {
    const { copies } = findCopies(work, deps.disclosureSources)
    summary.disclosure = copies.length === 0 ? 'passed' : 'failed'
    for (const c of copies.slice(0, 5)) {
      findings.push(finding('builder.disclosure', { file: c.file, line: null, message: 'The tool copies course material students can’t see yet.', detail: quote(c.label) }))
    }
  }

  // Compile and typecheck.
  const missing = PLUGIN_PATHS.filter((p) => typeof work.files[p] !== 'string')
  if (missing.length > 0) {
    summary.compile = 'failed'
    for (const p of missing) findings.push(finding('builder.compile', { file: p, line: null, message: 'This view doesn’t exist yet. Create it with write_file.', detail: null }))
  } else {
    const files = work.files as Record<PluginPath, string>
    const checked = await deps.workerCheck(files)
    summary.compiler = checked.compiler
    const failedCompile = PLUGIN_PATHS.flatMap((p) => {
      const r = checked.compile[p]
      return r.ok ? [] : r.diagnostics
    })
    summary.compile = failedCompile.length === 0 ? 'passed' : 'failed'
    for (const d of failedCompile) findings.push(finding('builder.compile', { file: d.file, line: d.line, message: `${d.code}: ${d.message}`, detail: null }))
    summary.typecheck = checked.typecheck.diagnostics.length === 0 ? 'passed' : 'failed'
    for (const d of checked.typecheck.diagnostics) findings.push(finding('builder.typecheck', { file: d.file, line: d.line, message: `${d.code}: ${d.message}`, detail: null }))

    const student = checked.compile['views/student.tsx']
    const professor = checked.compile['views/professor.tsx']
    if (student.ok && professor.ok) {
      bundles = { student: student.bundle, professor: professor.bundle }
      // Stage 1, on the artifact a Save would publish.
      if (manifest) {
        const artifact: PluginArtifact = {
          manifest,
          source: { ...files, 'plugin.manifest.json': canonicalJson(manifest) },
          studentBundle: bundles.student,
          professorBundle: bundles.professor,
        }
        const report = await runStaticChecks({
          artifact,
          storedHash: artifactHash(artifact),
          deadline: Date.now() + 10_000,
          // The classifier runs at Save, never in the loop.
          classify: async () => ({ ok: false, reason: 'disabled' }),
        })
        for (const [id, outcome] of Object.entries(report.outcomes) as [StaticCheckId, (typeof report.outcomes)[StaticCheckId]][]) {
          if (id === 'artifact.hash' || id === 'edtech.purpose') continue
          summary.static[id] = outcome.status
          if (outcome.status !== 'passed' && outcome.status !== 'skipped') findings.push(...staticFindings(id, outcome.status, outcome.message, outcome.metadata))
        }
      }
    }
  }

  const blocking = findings.filter((f) => f.required)
  const staticPassed = bundles !== null && manifest !== null && DRAFT_REQUIRED.every((id) => summary.static[id] === 'passed')
  const passed =
    blocking.length === 0 &&
    staticPassed &&
    summary.compile === 'passed' &&
    summary.typecheck === 'passed' &&
    summary.manifest === 'passed' &&
    summary.purpose_text === 'passed' &&
    summary.roster === 'passed' &&
    summary.disclosure === 'passed'
  summary.passed = passed

  const group = (list: BuilderFinding[]) => {
    const counts = new Map<string, { check_id: BuilderCheckId; file: string | null; count: number }>()
    for (const f of list) {
      const key = `${f.check_id}|${f.file}`
      const entry = counts.get(key) ?? { check_id: f.check_id, file: f.file, count: 0 }
      entry.count += 1
      counts.set(key, entry)
    }
    return [...counts.values()].slice(0, 10)
  }
  summary.unresolved = group(blocking)
  summary.warnings = group(findings.filter((f) => !f.required))

  // Required first, then by severity, then by file and line.
  findings.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      String(a.file).localeCompare(String(b.file)) ||
      (a.line ?? 0) - (b.line ?? 0),
  )
  return { workHash: hash, passed, findings: findings.slice(0, STUDIO_BUILDER_FINDINGS_MAX), totalFindings: findings.length, summary, bundles, compiler: summary.compiler }
}

/** The blocking findings' keys, for the same-finding rule. */
export const blockingKeys = (findings: readonly BuilderFinding[]) => [...new Set(findings.filter((f) => f.required).map((f) => `${f.check_id}|${f.file}`))]
