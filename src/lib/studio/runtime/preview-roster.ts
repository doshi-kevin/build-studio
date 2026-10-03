/**
 * The fixed synthetic class every draft preview, sample data set and design review uses
 * (docs/designs/studio/studio-builder-quality.md 3.7). No real student ever appears in a
 * preview: the names are invented for Scholera and belong to no one. The handles have
 * the real format (st_ plus 20 base32hex characters, so every check that parses a handle
 * accepts them) and read as samples: st_sample00000000000000 to st_sample00000000000011.
 *
 * Sample data refers to these students by index (0 to 11). In a student-view preview the
 * viewer is student 0. Pure: the browser host, the preview bridge and the builder share it.
 */

export interface PreviewStudent {
  handle: string
  name: string
}

const NAMES = [
  'Amara Okonkwo-Reyes',
  'Mateo Valdivieso',
  'Priya Ramanathan',
  'Liam Achterberg',
  'Sofia Marchetti-Lund',
  'Kenji Halvorsen',
  'Zainab Al-Mansouri',
  'Noah Featherstone',
  'Lucía Etxeberria',
  'Tariq Oyelaran',
  'Hannah Wierzbowska',
  'Daniel Asante-Brook',
] as const

export const PREVIEW_ROSTER: readonly PreviewStudent[] = Object.freeze(
  NAMES.map((name, i) => Object.freeze({ handle: `st_sample${String(i).padStart(14, '0')}`, name })),
)

/** The previewing student in a student-view preview. */
export const PREVIEW_VIEWER_STUDENT = 0

/** Display names by handle, the shape the host's roster overlay asks for. */
export const previewRosterNames = (): Record<string, string> =>
  Object.fromEntries(PREVIEW_ROSTER.map((s) => [s.handle, s.name]))
