/**
 * Stage 1: every static check, applied to one artifact. Pure apart from the injected
 * purpose classifier: no database, no session, and no plugin code is executed.
 *
 * The bundles are what the validator scans, because they are what runs (decision D1:
 * they hold plugin code only). The source is checked for limits, entries and imports.
 */
import ts from 'typescript'
import { methodAllowed, methodSpec } from '../bridge/catalog'
import {
  STUDIO_BUNDLE_MAX_BYTES,
  STUDIO_SOURCE_FILE_MAX_BYTES,
  STUDIO_SOURCE_MAX_BYTES,
  STUDIO_SOURCE_MAX_FILES,
  STUDIO_VALIDATOR_FINDINGS_PER_CHECK,
} from '../limits'
import { parseManifest, type StudioManifest } from '../manifest'
import { artifactHash, type PluginArtifact } from './artifact'
import { evaluatePurpose, type PurposeClassifier } from './purpose'
import { checksFor, type StaticCheckId } from './ruleset'
import { quote, scanCode, type Finding, type FindingKind, type ScanResult } from './scan'

export type CheckStatus = 'passed' | 'failed' | 'warning' | 'needs_review' | 'skipped' | 'error'

export interface CheckOutcome {
  status: CheckStatus
  message: string
  metadata?: Record<string, unknown>
}

export interface StaticInput {
  artifact: PluginArtifact
  /** The hash stored on the version at publish; null for versions from before it. */
  storedHash: string | null
  deadline: number
  classify: PurposeClassifier
}

export interface StaticReport {
  outcomes: Record<StaticCheckId, CheckOutcome>
  aiModel?: string
}

type View = 'student' | 'professor'
const VIEWS: View[] = ['student', 'professor']
const ALLOWED_IMPORTS = new Set(['react', '@scholera/plugin-kit'])
const VENDOR_MARKERS = /__SECRET_INTERNALS|__CLIENT_INTERNALS|react\.transitional\.element|react\.element|ReactCurrentOwner|ReactDOM|scheduler\.production|unstable_scheduleCallback/

const bytes = (s: string) => new TextEncoder().encode(s).length
const pass = (message: string, metadata?: Record<string, unknown>): CheckOutcome => ({ status: 'passed', message, metadata })
const fail = (message: string, metadata?: Record<string, unknown>): CheckOutcome => ({ status: 'failed', message, metadata })
const skip = (message: string): CheckOutcome => ({ status: 'skipped', message })

/** Findings as bounded metadata: view, line and a short quote, never code. */
function listed(found: { view: View; finding: Finding }[]) {
  return {
    count: found.length,
    findings: found.slice(0, STUDIO_VALIDATOR_FINDINGS_PER_CHECK).map(({ view, finding }) => ({ view, line: finding.line, detail: finding.detail })),
  }
}

/** Imports a source file names, without parsing it fully: TypeScript's import scanner. */
function importsOf(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName)
}

/** Whether a relative import stays inside the plugin's own source. */
function staysInside(from: string, spec: string): boolean {
  const parts = from.split('/').slice(0, -1)
  for (const segment of spec.split('/')) {
    if (segment === '..') {
      if (parts.length === 0) return false
      parts.pop()
    } else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return true
}

export async function runStaticChecks(input: StaticInput): Promise<StaticReport> {
  const { artifact } = input
  const outcomes = {} as Record<StaticCheckId, CheckOutcome>
  let aiModel: string | undefined

  // ── The artifact ──
  const recomputed = artifactHash(artifact)
  outcomes['artifact.hash'] =
    input.storedHash === null
      ? fail('This version was published before artifacts were hashed. Publish it again to check it.')
      : input.storedHash !== recomputed
        ? fail('The stored version doesn’t match the artifact it was published as.', { stored: input.storedHash.slice(0, 12), actual: recomputed.slice(0, 12) })
        : pass('The artifact is exactly the one published.')

  const files = Object.entries(artifact.source)
  const fileBytes = files.map(([path, content]) => ({ path, size: bytes(typeof content === 'string' ? content : JSON.stringify(content ?? null)) }))
  const sourceBytes = fileBytes.reduce((n, f) => n + f.size, 0)
  const bundleBytes = { student: bytes(artifact.studentBundle), professor: bytes(artifact.professorBundle) }
  const tooBig = [
    sourceBytes > STUDIO_SOURCE_MAX_BYTES && `source is ${sourceBytes} bytes (limit ${STUDIO_SOURCE_MAX_BYTES})`,
    files.length > STUDIO_SOURCE_MAX_FILES && `${files.length} source files (limit ${STUDIO_SOURCE_MAX_FILES})`,
    ...fileBytes.filter((f) => f.size > STUDIO_SOURCE_FILE_MAX_BYTES).slice(0, 5).map((f) => `${quote(f.path)} is ${f.size} bytes`),
    ...VIEWS.filter((v) => bundleBytes[v] > STUDIO_BUNDLE_MAX_BYTES).map((v) => `${v} bundle is ${bundleBytes[v]} bytes (limit ${STUDIO_BUNDLE_MAX_BYTES})`),
  ].filter((x): x is string => typeof x === 'string')
  const sizeOk = tooBig.length === 0
  outcomes['artifact.size'] = sizeOk
    ? pass('Within the size and file limits.', { sourceBytes, files: files.length, bundleBytes })
    : fail('This tool is larger than Studio allows.', { problems: tooBig })

  const manifestResult = parseManifest(artifact.manifest)
  const manifest: StudioManifest | null = manifestResult.ok ? manifestResult.manifest : null
  outcomes['manifest.valid'] = manifestResult.ok
    ? pass(`Manifest version ${manifestResult.manifest.manifestVersion} is valid.`)
    : fail('The manifest isn’t valid.', { issues: manifestResult.issues.slice(0, STUDIO_VALIDATOR_FINDINGS_PER_CHECK).map(quote) })

  if (!manifest) {
    outcomes['artifact.entries'] = skip('Needs a valid manifest.')
  } else {
    const missing = VIEWS.flatMap((v) => [
      ...(Object.hasOwn(artifact.source, manifest.views[v].entry) ? [] : [`${v} entry ${quote(manifest.views[v].entry)} is missing from the source`]),
      ...((v === 'student' ? artifact.studentBundle : artifact.professorBundle).trim() ? [] : [`${v} bundle is empty`]),
    ])
    outcomes['artifact.entries'] = missing.length === 0 ? pass('Both views have their source entry and code.') : fail('A view is missing its source or code.', { missing })
  }

  outcomes['artifact.vendor_free'] = VIEWS.some((v) => VENDOR_MARKERS.test(v === 'student' ? artifact.studentBundle : artifact.professorBundle))
    ? fail('A bundle includes React or kit code. Those come from the Studio runtime; bundles hold the tool’s own code only.')
    : pass('Bundles hold the tool’s own code only.')

  // Source imports: React, the kit, and the tool's own files.
  if (!sizeOk) {
    outcomes['source.imports'] = skip('Needs the source within its limits.')
  } else {
    const bad: string[] = []
    for (const [path, content] of files) {
      if (typeof content !== 'string') {
        bad.push(`${quote(path)} isn’t text`)
        continue
      }
      for (const spec of importsOf(content)) {
        const relative = spec.startsWith('./') || spec.startsWith('../')
        if (relative ? !staysInside(path, spec) : !ALLOWED_IMPORTS.has(spec)) bad.push(`${quote(path)} imports ${quote(spec)}`)
      }
    }
    outcomes['source.imports'] = bad.length === 0 ? pass('Imports only React, the kit and its own files.') : fail('The source imports something Studio doesn’t provide.', { imports: bad.slice(0, STUDIO_VALIDATOR_FINDINGS_PER_CHECK) })
  }

  // ── Plugin code: scan what runs ──
  const scans: Partial<Record<View, ScanResult>> = {}
  if (sizeOk) {
    for (const v of VIEWS) scans[v] = scanCode(v === 'student' ? artifact.studentBundle : artifact.professorBundle, input.deadline)
  }
  const failedScan = VIEWS.map((v) => ({ v, s: scans[v] })).find(({ s }) => s && !s.ok)
  const scanned = sizeOk && !failedScan
  if (!sizeOk) {
    outcomes['artifact.syntax'] = skip('Needs the bundles within their limits.')
  } else if (failedScan && failedScan.s && !failedScan.s.ok) {
    const { reason, detail } = failedScan.s
    outcomes['artifact.syntax'] =
      reason === 'timeout'
        ? { status: 'error', message: 'The checks ran out of time.', metadata: { view: failedScan.v } }
        : fail(reason === 'syntax' ? 'A bundle isn’t valid JavaScript.' : 'A bundle is too deeply nested or too large to check.', { view: failedScan.v, reason, detail })
  }

  const all = (kinds: FindingKind[], only?: View) =>
    VIEWS.filter((v) => !only || v === only).flatMap((view) => {
      const s = scans[view]
      return s && s.ok ? s.findings.filter((f) => kinds.includes(f.kind)).map((finding) => ({ view, finding })) : []
    })

  if (scanned) {
    const moduleSyntax = all(['module_syntax', 'jsx'])
    outcomes['artifact.syntax'] = moduleSyntax.length > 0
      ? fail('Bundles must be compiled, plain scripts: no imports, exports, require or JSX.', listed(moduleSyntax))
      : pass('Both bundles are plain scripts within the parse limits.')
  }

  const codeCheck = (id: StaticCheckId, kinds: FindingKind[], bad: string, good: string) => {
    if (!scanned) return (outcomes[id] = skip('Needs bundles that parse.'))
    const found = all(kinds)
    outcomes[id] = found.length > 0 ? fail(bad, listed(found)) : pass(good)
  }
  codeCheck('code.navigation', ['navigation'], 'The tool tries to navigate its own frame or open a page. Tools can’t leave their frame.', 'No navigation.')
  codeCheck('code.global_indirection', ['global_indirection'], 'The tool reaches browser globals indirectly, which hides what it uses.', 'No hidden access to browser globals.')
  codeCheck('code.html_injection', ['html_injection'], 'The tool writes raw HTML. Use kit components and plain text.', 'No raw HTML.')
  codeCheck('code.dynamic_code', ['dynamic_code'], 'The tool builds code at run time (eval, new Function, string timers or dynamic import). The runtime blocks these.', 'No code built at run time.')
  codeCheck('code.network', ['network'], 'The tool uses the network directly. Tools reach Scholera only through the Bridge; the runtime blocks direct requests.', 'No direct network use.')
  codeCheck('code.storage', ['storage'], 'The tool uses browser storage or cookies. Tools save data through the Bridge; the sandbox blocks storage.', 'No browser storage.')
  codeCheck('code.workers', ['workers'], 'The tool starts a worker. The runtime blocks workers.', 'No workers.')
  codeCheck('code.device_apis', ['device_apis'], 'The tool uses a device or connection API (camera, microphone, location, clipboard, notifications or WebRTC). The runtime blocks these.', 'No device APIs.')
  codeCheck('kit.components_only', ['intrinsic_element', 'dom_building'], 'The tool builds its screen from raw HTML elements or DOM calls. Use kit components.', 'Screens use kit components only.')
  codeCheck('kit.no_hardcoded_style', ['style_prop', 'color_literal'], 'The tool sets its own styles or colors. Kit components use Scholera’s theme.', 'No custom styles or colors.')

  // Bridge calls: literal methods must exist and be declared for that view.
  if (!scanned || !manifest) {
    outcomes['code.bridge_usage'] = skip('Needs bundles that parse and a valid manifest.')
  } else {
    const bypass = all(['bridge_bypass'])
    const wrong = VIEWS.flatMap((view) =>
      all(['bridge_call'], view).filter(({ finding }) => {
        const spec = methodSpec(finding.detail)
        return !spec || !methodAllowed(spec, manifest, view)
      }),
    )
    const computed = all(['bridge_computed'])
    outcomes['code.bridge_usage'] =
      bypass.length + wrong.length > 0
        ? fail('The tool calls Bridge methods it hasn’t declared for that view, or tries to message Scholera directly.', listed([...bypass, ...wrong]))
        : computed.length > 0
          ? { status: 'warning', message: 'Some Bridge calls name their method at run time, so they can’t be checked here. The Bridge still refuses undeclared methods.', metadata: listed(computed) }
          : pass('Every Bridge call is declared for its view.')
  }

  if (!scanned) {
    outcomes['code.external_urls'] = skip('Needs bundles that parse.')
    outcomes['kit.required_states'] = skip('Needs bundles that parse.')
    outcomes['data.answer_key'] = skip('Needs bundles that parse.')
  } else {
    const urls = all(['external_url'])
    outcomes['code.external_urls'] = urls.length > 0
      ? { status: 'warning', message: 'The tool’s code contains web addresses. It can’t load them; if they’re shown as text, that’s fine.', metadata: listed(urls) }
      : pass('No web addresses in the code.')

    const missing = VIEWS.flatMap((v) => {
      const s = scans[v]
      const names = s && s.ok ? s.kitNames : new Set<string>()
      return ['Loading', 'Empty', 'ErrorState'].filter((n) => !names.has(n)).map((n) => `${v} view doesn’t use ${n}`)
    })
    outcomes['kit.required_states'] = missing.length === 0
      ? pass('Both views use the kit’s loading, empty and error states.')
      : fail('Every view needs a loading, an empty and an error state from the kit.', { missing })

    const keys = all(['answer_key'], 'student')
    outcomes['data.answer_key'] = keys.length > 0
      ? { status: 'needs_review', message: 'The student view’s code contains what looks like an answer key. A Scholera reviewer needs to check it; answer keys belong in a staff-only collection.', metadata: listed(keys) }
      : pass('No answer-key-shaped data in the student view.')
  }

  // ── Edtech: manifest v2 ──
  const v2 = manifest && manifest.manifestVersion === 2 ? manifest : null
  const needsV2 = 'This check needs manifest version 2. Rebuild the tool to show it to students.'
  if (!manifest) {
    for (const id of ['edtech.purpose', 'edtech.signals', 'edtech.skill_slots', 'edtech.ai_fallback'] as const) outcomes[id] = skip('Needs a valid manifest.')
  } else if (!v2) {
    for (const id of ['edtech.purpose', 'edtech.signals', 'edtech.skill_slots', 'edtech.ai_fallback'] as const) outcomes[id] = fail(needsV2)
  } else {
    const purpose = await evaluatePurpose(v2, input.classify)
    outcomes['edtech.purpose'] = { status: purpose.status, message: purpose.message, metadata: purpose.metadata }
    aiModel = purpose.model

    outcomes['edtech.signals'] = pass(
      v2.signals.length > 0 ? 'Tracking uses only the shared signal list.' : 'The tool tracks no signals.',
      { signals: v2.signals },
    )
    const idLike = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    const badSlots = v2.skillSlots.filter((s) => idLike.test(s.key) || idLike.test(s.label)).map((s) => quote(s.key))
    outcomes['edtech.skill_slots'] = badSlots.length > 0
      ? fail('A skill slot names a specific skill. Slots name a concept; each course binds its own skill.', { slots: badSlots })
      : pass(v2.skillSlots.length > 0 ? 'Skill slots name concepts only.' : 'The tool counts toward no skills.', { slots: v2.skillSlots.map((s) => s.key) })
    outcomes['edtech.ai_fallback'] = pass('The manifest says what happens when AI is switched off.', { aiFallback: v2.aiFallback })
  }

  // Every static check in the ruleset has an outcome.
  for (const def of checksFor('static')) {
    if (!outcomes[def.id as StaticCheckId]) outcomes[def.id as StaticCheckId] = { status: 'error', message: 'This check didn’t run.' }
  }
  return { outcomes, aiModel }
}
