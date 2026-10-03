/**
 * The host-rendered roster's geometry and limits, shared by both sides of the frame
 * (docs/designs/studio/studio-builder-quality.md 3.4). The kit's RosterTable reserves
 * exactly `rosterHeight` in the plugin frame and the host draws its table over that box,
 * so no measured size ever travels back to the plugin: a height that depended on names
 * would leak them.
 *
 * Pure and import-free: vendor.js v2 bundles it, and so does the host.
 */

export const ROSTER_ROW_PX = 56
export const ROSTER_HEADER_PX = 48
export const ROSTER_SEARCH_PX = 64

/** Strict-parse bounds for a RosterPayload. The kit clamps text to them before it posts. */
export const ROSTER_LIMITS = {
  slot: /^[a-z0-9]{1,16}$/,
  columnKey: /^[a-z][a-zA-Z0-9]{0,23}$/,
  label: 80,
  header: 40,
  columns: 4,
  rows: 500,
  emptyText: 120,
  text: 60,
  badge: 40,
  choiceOptions: { min: 2, max: 4 },
  optionLabel: 24,
  selectOptions: 20,
  buttonLabel: 24,
  selectPlaceholder: 40,
  value: 40,
} as const

/**
 * The box the table needs, in CSS px. An empty roster keeps one row for its empty text.
 * Search filtering never shrinks it: matches fill from the top and the rest stays blank.
 */
export function rosterHeight(rows: number, searchable: boolean): number {
  const n = Number.isFinite(rows) ? Math.min(Math.max(Math.floor(rows), 1), ROSTER_LIMITS.rows) : 1
  return (searchable ? ROSTER_SEARCH_PX : 0) + ROSTER_HEADER_PX + n * ROSTER_ROW_PX
}
