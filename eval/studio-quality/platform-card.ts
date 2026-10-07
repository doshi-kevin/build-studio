/**
 * What a Studio plugin can and can't do, for the judge, so it never rewards a feature the
 * platform doesn't allow or marks a plugin down for leaving one out. Built from the
 * platform's own constants every time, never copied: the capability registry and Bridge
 * catalog, the access modes and field types the manifest validator accepts, the plugin
 * card's wording, the kit's imports, the frame's security policy and the limits.
 */
import { CAPABILITIES } from '../../src/lib/studio/capabilities'
import { METHOD_CATALOG } from '../../src/lib/studio/bridge/catalog'
import { parseManifest, type StudioManifest } from '../../src/lib/studio/manifest'
import { buildPluginCard, humanize } from '../../src/lib/studio/plugin-card'
import { KIT_IMPORTS } from '../../src/lib/studio/kit/plugin-kit-types'
import { frameCsp } from '../../src/lib/studio/runtime/frame-document'
import { AVAILABLE_CAPABILITIES } from '../../src/lib/studio/builder/manifest-delta'
import { PLUGIN_PATHS } from '../../src/lib/studio/builder/paths'
import {
  STUDIO_BUILDER_FILE_MAX_BYTES,
  STUDIO_MANIFEST_MAX_COLLECTIONS,
  STUDIO_MANIFEST_MAX_FIELDS,
  STUDIO_RECORD_MAX_BYTES,
  STUDIO_ROSTER_MAX,
} from '../../src/lib/studio/limits'
import { sha256 } from './freeze'

export interface PlatformFacts {
  capabilities: { name: string; label: string; views: string[]; available: boolean }[]
  methods: { name: string; capability: string | null; views: string[]; kind: string }[]
  accessModes: { mode: string; label: string; students: string; staff: string }[]
  fieldTypes: string[]
  kit: string[]
  frameRestrictions: string[]
  fixed: string[]
  limits: Record<string, number>
}

/** How many records of one collection `useRecords` loads in a view: `RECORDS_MAX` in
 * src/lib/studio/kit/v2/components.tsx, which doesn't export it. A test checks they match. */
export const KIT_RECORDS_LOAD_MAX = 1000

const PROBE = '__probe__'

/** A minimal valid manifest v2 with the given collections, to ask the real validator and plugin card. */
function probeManifest(collections: Record<string, unknown>): unknown {
  return {
    manifestVersion: 2,
    id: 'probe-plugin',
    name: 'Probe',
    version: '0.0.0',
    description: 'A probe used to read the platform contract.',
    bridgeVersion: 'v2',
    purpose: { category: 'practice', summary: 'Students write short notes so they can review what they practised during the course.', audience: 'students' },
    signals: [],
    skillSlots: [],
    aiFallback: 'not-applicable',
    views: {
      student: { entry: 'views/student.tsx', capabilities: [] },
      professor: { entry: 'views/professor.tsx', capabilities: [] },
    },
    collections,
  }
}

/** The options a zod enum names in its error for a value it doesn't accept. */
function optionsFromIssue(collection: Record<string, unknown>): string[] {
  const result = parseManifest(probeManifest({ probe: collection }))
  const issue = result.ok ? '' : result.issues.join(' ')
  return [...issue.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).filter((o) => o !== PROBE)
}

export function platformFacts(): PlatformFacts {
  const accessModes = optionsFromIssue({ access: PROBE, fields: { a: 'text' } })
  const fieldTypes = optionsFromIssue({ access: accessModes[0], fields: { a: PROBE } })
  if (accessModes.length === 0 || fieldTypes.length === 0) throw new Error('The manifest validator no longer names its access modes or field types.')

  const collections = Object.fromEntries(accessModes.map((mode) => [mode, { access: mode, fields: { note: fieldTypes[0] } }]))
  const parsed = parseManifest(probeManifest(collections))
  if (!parsed.ok) throw new Error(`The platform card's probe manifest is invalid: ${parsed.issues.join('; ')}`)
  const card = buildPluginCard(parsed.manifest as StudioManifest, null)
  // Card lines read "<what> <collection name>"; the probe names each collection after its mode.
  const lineFor = (lines: string[], mode: string) => {
    const suffix = ` ${humanize(mode)}`
    const line = lines.find((l) => l.endsWith(suffix))
    return line ? line.slice(0, -suffix.length) : ''
  }
  const csp = frameCsp({ appOrigin: 'https://app.example.org', runtimeOrigin: 'https://runtime.example.net', nonce: 'cHJvYmVub25jZXByb2Jlbm9uY2U', runtime: 'v2' })

  return {
    capabilities: Object.entries(CAPABILITIES).map(([name, c]) => ({
      name,
      label: c.label,
      views: [...c.views],
      available: (AVAILABLE_CAPABILITIES as string[]).includes(name),
    })),
    methods: Object.entries(METHOD_CATALOG).map(([name, m]) => ({ name, capability: m.capability, views: [...m.views], kind: m.kind })),
    accessModes: accessModes.map((mode) => {
      const data = card.data.find((d) => d.name === humanize(mode))
      return {
        mode,
        label: data?.access ?? '',
        students: lineFor(card.students, mode) || 'Nothing: never sent to a student',
        staff: lineFor(card.professors, mode),
      }
    }),
    fieldTypes,
    kit: [...KIT_IMPORTS['@scholera/plugin-kit']],
    frameRestrictions: csp
      .split('; ')
      .filter((d) => /'none'|sandbox/.test(d))
      .map((d) => d.trim()),
    fixed: [card.ai, card.grading, card.tracking],
    limits: {
      views: PLUGIN_PATHS.length,
      collections: STUDIO_MANIFEST_MAX_COLLECTIONS,
      fieldsPerCollection: STUDIO_MANIFEST_MAX_FIELDS,
      recordBytes: STUDIO_RECORD_MAX_BYTES,
      rosterStudents: STUDIO_ROSTER_MAX,
      viewSourceBytes: STUDIO_BUILDER_FILE_MAX_BYTES,
    },
  }
}

/** The card as the judge reads it. */
export function platformCardText(facts: PlatformFacts = platformFacts()): string {
  const lines = [
    '# What a Studio plugin can do',
    `A plugin is exactly ${facts.limits.views} views: one for professors and course staff, one for students. It runs in a sandboxed frame and can do nothing but what is listed here.`,
    '',
    '## Capabilities a view can declare',
    ...facts.capabilities.map((c) => `- ${c.name} (${c.views.join(' and ')} view${c.views.length > 1 ? 's' : ''})${c.available ? '' : ', registered but not available yet'}: ${c.label}`),
    '',
    '## Saved data',
    `Up to ${facts.limits.collections} collections of up to ${facts.limits.fieldsPerCollection} fields each. Field types: ${facts.fieldTypes.join(', ')}. One record is at most ${facts.limits.recordBytes} bytes. Every collection has one access mode:`,
    ...facts.accessModes.map((a) => `- ${a.mode}: ${a.label}. Students: ${a.students}. Staff: ${a.staff}.`),
    'Students never read another student’s records. Only staff write shared records.',
    '',
    '## Interface',
    `Views use only these kit components and helpers, with no HTML elements, styles or colours of their own: ${facts.kit.join(', ')}.`,
    `RosterTable shows the class (up to ${facts.limits.rosterStudents} students) to staff; names are drawn by Scholera and the plugin only ever sees anonymous handles.`,
    '',
    '## Not possible',
    ...facts.fixed.map((f) => `- ${f}`),
    '- No other Scholera data: no grades, submissions or messages. No email, outside notifications or calendar.',
    `- The frame's security policy: ${facts.frameRestrictions.join('; ')}. So no network, images, embedded pages, forms, workers or navigation.`,
  ]
  return lines.join('\n')
}

export const platformCardSha256 = (text: string) => sha256(text)
