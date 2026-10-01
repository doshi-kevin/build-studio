// Student-customizable category colors for the calendar + dashboard.
//
// Each category (class, assignment, quiz, challenge, office hours) is driven by a
// CSS variable (`--cal-*`, defaults in globals.css). Every surface reads the
// variable, so a student's choice applies uniformly whether the markup is server-
// or client-rendered. Choices are stored per-browser in localStorage; a small
// client initializer applies them to the document root on load.

import type { CSSProperties } from 'react'
import type { StudentCalendarEventKind } from './student-events'

export type CategoryKey = 'class' | 'assignment' | 'quiz' | 'project' | 'officeHours' | 'personal'

export interface CategoryDef {
  key: CategoryKey
  label: string
  cssVar: string
}

export const CATEGORIES: CategoryDef[] = [
  { key: 'class', label: 'Class', cssVar: '--cal-class' },
  { key: 'assignment', label: 'Assignment', cssVar: '--cal-assignment' },
  { key: 'quiz', label: 'Quiz', cssVar: '--cal-quiz' },
  { key: 'project', label: 'Project', cssVar: '--cal-project' },
  { key: 'officeHours', label: 'Office Hours', cssVar: '--cal-office-hours' },
  { key: 'personal', label: 'Personal', cssVar: '--cal-personal' },
]

const CSS_VAR: Record<CategoryKey, string> = {
  class: '--cal-class',
  assignment: '--cal-assignment',
  quiz: '--cal-quiz',
  project: '--cal-project',
  officeHours: '--cal-office-hours',
  personal: '--cal-personal',
}

/** Calendar event kind → category. */
export const KIND_CATEGORY: Record<StudentCalendarEventKind, CategoryKey> = {
  class_session: 'class',
  assignment_due: 'assignment',
  quiz_due: 'quiz',
  project_due: 'project',
  office_hours_booking: 'officeHours',
  personal: 'personal',
}

/** To-do list kind → category (so its icon takes the same color as the calendar). */
export const TODO_KIND_CATEGORY: Record<'assignment' | 'quiz' | 'project', CategoryKey> = {
  assignment: 'assignment',
  quiz: 'quiz',
  project: 'project',
}

/** Professor to-do kind → category. Same palette as the student list, so the
 *  two dashboards read as one product rather than two. */
export const PROFESSOR_TODO_KIND_CATEGORY: Record<
  'grading' | 'deadline' | 'class_prep' | 'class_report',
  CategoryKey
> = {
  grading: 'assignment',
  deadline: 'quiz',
  class_prep: 'class',
  class_report: 'class',
}

/** The CSS value that resolves to a category's current color. */
export function categoryColor(key: CategoryKey): string {
  return `var(${CSS_VAR[key]})`
}

/** Solid fill (dots, markers). */
export function dotStyle(key: CategoryKey): CSSProperties {
  return { backgroundColor: categoryColor(key) }
}

/**
 * Soft tinted chip/block: a low-opacity fill of the category color, with the
 * text/icon in a DARKENED version of that color (not the base hue). The base
 * chart tokens are too light to read as text on their own tint — the base blue
 * measured ~3.9:1 and violet ~4.07:1, below the 4.5:1 AA floor (see globals.css),
 * and the picker offers even lighter choices. Mixing 45% black drops lightness to
 * ~0.3–0.42 across the palette (AA-safe on the near-white tint) while keeping the
 * hue, so the color coding survives. Dots/accents keep the bright base color.
 */
export function tintStyle(key: CategoryKey): CSSProperties {
  const c = categoryColor(key)
  return {
    backgroundColor: `color-mix(in oklch, ${c} 12%, transparent)`,
    color: `color-mix(in oklch, ${c}, black 45%)`,
  }
}

/** Left accent border for timed blocks. */
export function accentStyle(key: CategoryKey): CSSProperties {
  return { borderLeftColor: categoryColor(key) }
}

// ── Selectable palette ───────────────────────────────────────────────────────

export interface Swatch {
  name: string
  value: string
}

/** On-theme preset color choices offered in the per-category picker. Students can
 *  also enter any custom hex (see CalendarColorSettings). */
export const COLOR_PALETTE: Swatch[] = [
  { name: 'Blue', value: 'oklch(0.56 0.19 260)' },
  { name: 'Sky', value: 'oklch(0.68 0.14 230)' },
  { name: 'Cyan', value: 'oklch(0.72 0.13 210)' },
  { name: 'Teal', value: 'oklch(0.70 0.12 195)' },
  { name: 'Green', value: 'oklch(0.58 0.13 152)' },
  { name: 'Emerald', value: 'oklch(0.64 0.15 160)' },
  { name: 'Lime', value: 'oklch(0.75 0.16 130)' },
  { name: 'Amber', value: 'oklch(0.76 0.14 80)' },
  { name: 'Orange', value: 'oklch(0.68 0.18 45)' },
  { name: 'Red', value: 'oklch(0.63 0.20 18)' },
  { name: 'Rose', value: 'oklch(0.62 0.21 5)' },
  { name: 'Pink', value: 'oklch(0.64 0.20 350)' },
  { name: 'Fuchsia', value: 'oklch(0.60 0.24 320)' },
  { name: 'Purple', value: 'oklch(0.58 0.18 295)' },
  { name: 'Indigo', value: 'oklch(0.52 0.20 275)' },
  { name: 'Slate', value: 'oklch(0.55 0.03 250)' },
]

// ── Persistence (per-browser) ────────────────────────────────────────────────

const STORAGE_KEY = 'scholera:calendarColors'

/** Read the saved overrides (category → color value). Safe on the server. */
export function loadCalendarColors(): Partial<Record<CategoryKey, string>> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<Record<CategoryKey, string>>) : {}
  } catch {
    return {}
  }
}

/** Persist one category's color and apply it immediately. */
export function saveCalendarColor(key: CategoryKey, value: string): void {
  if (typeof window === 'undefined') return
  const next = { ...loadCalendarColors(), [key]: value }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* storage full / disabled — the in-memory var set below still applies for this session */
  }
  document.documentElement.style.setProperty(CSS_VAR[key], value)
}

/** Clear one category's override and fall back to the stylesheet default. */
export function resetCalendarColor(key: CategoryKey): void {
  if (typeof window === 'undefined') return
  const next = loadCalendarColors()
  delete next[key]
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* storage disabled — removing the inline var below still reverts this session */
  }
  // Removing the inline var lets the :root default in globals.css take over again.
  document.documentElement.style.removeProperty(CSS_VAR[key])
}

/** Apply all saved overrides to the document root (call once on load). */
export function applyCalendarColors(): void {
  if (typeof window === 'undefined') return
  const saved = loadCalendarColors()
  for (const cat of CATEGORIES) {
    const v = saved[cat.key]
    if (v) document.documentElement.style.setProperty(cat.cssVar, v)
  }
}
