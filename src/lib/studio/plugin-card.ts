/**
 * The plugin card (rule 8.2): what a professor reads before a plugin reaches students.
 * Pure and client-safe; built on the server from the stored manifest and storage figures,
 * rendered by the publication dialog. Every line comes from the manifest or the database,
 * never from the plugin at run time.
 */
import { CAPABILITIES } from './capabilities'
import type { StudioManifest } from './manifest'

export interface StorageFigures {
  records: number
  bytes: number
  installationMaxRecords: number
  installationMaxBytes: number
  studentMaxRecords: number
  studentMaxBytes: number
}

export interface PluginCard {
  name: string
  version: string
  description: string
  /** Plain sentences, one per thing the view can do. */
  students: string[]
  professors: string[]
  /** One line per collection: its name and who reads and writes it. */
  data: { name: string; fields: string[]; access: string }[]
  /** No V1 capability uses AI, grades, or tracks signals; said explicitly, not omitted. */
  ai: string
  grading: string
  tracking: string
  storage: { used: string; perStudent: string } | null
}

const ACCESS: Record<StudioManifest['collections'][string]['access'], { label: string; students: string | null; staff: string }> = {
  perStudent: {
    label: 'Each student’s own work. A student sees only theirs; course staff see everyone’s',
    students: 'Save their own',
    staff: 'Read every student’s',
  },
  staffPerStudent: {
    label: 'Staff record something for each student; each student sees only their own',
    students: 'Read their own',
    staff: 'Record and read every student’s',
  },
  shared: {
    label: 'Written by staff, read by everyone in the course',
    students: 'Read',
    staff: 'Read and write',
  },
  staffOnly: {
    label: 'Staff only. Never sent to a student',
    students: null,
    staff: 'Read and write',
  },
}

const UNITS = ['bytes', 'KB', 'MB', 'GB'] as const

/** 1536 becomes "1.5 KB". Binary units, labeled the way people read them. */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded.toLocaleString('en-US')} ${UNITS[unit]}`
}

const count = (n: number) => n.toLocaleString('en-US')

/** "exitTickets" becomes "exit tickets": collection and field names are code identifiers. */
export const humanize = (name: string) => name.replace(/([A-Z])/g, ' $1').toLowerCase()

/** How the tool sits on the page, not something a person can do with it. */
const PRESENTATION: ReadonlySet<string> = new Set(['ui.resize', 'ui.toast'])

/** One line per server action a role may run: what the card's approval covers. */
function serverLines(manifest: StudioManifest, role: 'student' | 'professor'): string[] {
  if (manifest.manifestVersion !== 2 || !manifest.server) return []
  return Object.entries(manifest.server.actions)
    .filter(([, a]) => a.roles.includes(role))
    .map(([name, a]) => {
      // What the platform enforces: the code may read these. What it sends back is the tool's own choice.
      const hidden = role === 'student' && (a.reads ?? []).length > 0 ? `, which can look at ${(a.reads ?? []).map(humanize).join(', ')} (hidden from students). The tool’s code decides what the student gets back` : ''
      return `Run the tool’s server code “${humanize(name)}”${hidden}`
    })
}

/** A collection only the tool's own code writes: who reads it, with no writer the frame could be. */
const SERVER_LABEL: Record<StudioManifest['collections'][string]['access'], string> = {
  perStudent: 'Recorded by the tool’s own code. Each student sees only theirs; course staff see everyone’s',
  staffPerStudent: 'Recorded by the tool’s own code for each student. Each student sees only their own',
  shared: 'Recorded by the tool’s own code. Everyone in the course can read it',
  staffOnly: 'Recorded by the tool’s own code. Only you and your TAs see it',
}

/** What each role can do with a collection from the tool's screens. */
function collectionLine(c: StudioManifest['collections'][string], name: string, role: 'student' | 'professor'): string | null {
  const a = ACCESS[c.access]
  if (c.writes !== 'server') return role === 'student' ? (a.students ? `${a.students} ${humanize(name)}` : null) : `${a.staff} ${humanize(name)}`
  // Read-only from every screen: the tool's code does the writing.
  if (role === 'student') return c.access === 'staffOnly' ? null : c.access === 'shared' ? `Read ${humanize(name)}` : `Read their own ${humanize(name)}`
  return c.access === 'perStudent' || c.access === 'staffPerStudent' ? `Read every student’s ${humanize(name)}` : `Read ${humanize(name)}`
}

export function buildPluginCard(manifest: StudioManifest, storage: StorageFigures | null): PluginCard {
  const collections = Object.entries(manifest.collections)
  const abilities = (view: 'student' | 'professor') =>
    manifest.views[view].capabilities.filter((c) => !PRESENTATION.has(c)).map((c) => CAPABILITIES[c].label)

  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    students: [
      ...abilities('student'),
      ...collections.flatMap(([name, c]) => collectionLine(c, name, 'student') ?? []),
      ...serverLines(manifest, 'student'),
    ],
    professors: [...abilities('professor'), ...collections.flatMap(([name, c]) => collectionLine(c, name, 'professor') ?? []), ...serverLines(manifest, 'professor')],
    data: collections.map(([name, c]) => ({
      name: humanize(name),
      fields: Object.keys(c.fields).map(humanize),
      access: c.writes === 'server' ? SERVER_LABEL[c.access] : ACCESS[c.access].label,
    })),
    ai: 'This tool doesn’t use AI.',
    grading: 'This tool doesn’t grade or send scores to the gradebook.',
    tracking: 'This tool doesn’t record activity signals.',
    storage: storage && {
      used: `${count(storage.records)} of ${count(storage.installationMaxRecords)} saved entries, ${formatBytes(storage.bytes)} of ${formatBytes(storage.installationMaxBytes)}`,
      perStudent: `Each student can save up to ${count(storage.studentMaxRecords)} entries (${formatBytes(storage.studentMaxBytes)})`,
    },
  }
}

/** The plugin card lines `next` has that `previous` doesn't: what a new version adds. */
export function cardAdditions(next: PluginCard, previous: PluginCard): string[] {
  const lines = (c: PluginCard) => [
    ...c.students.map((l) => `Students can: ${l}`),
    ...c.professors.map((l) => `You can: ${l}`),
    ...c.data.map((d) => `Saves ${d.name}: ${d.access}. Includes ${d.fields.join(', ')}.`),
  ]
  const before = new Set(lines(previous))
  return lines(next).filter((l) => !before.has(l))
}
