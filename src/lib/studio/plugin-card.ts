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
      ...collections.flatMap(([name, c]) => (ACCESS[c.access].students ? [`${ACCESS[c.access].students} ${humanize(name)}`] : [])),
    ],
    professors: [...abilities('professor'), ...collections.map(([name, c]) => `${ACCESS[c.access].staff} ${humanize(name)}`)],
    data: collections.map(([name, c]) => ({
      name: humanize(name),
      fields: Object.keys(c.fields).map(humanize),
      access: ACCESS[c.access].label,
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
