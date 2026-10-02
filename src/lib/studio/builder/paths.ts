/**
 * The builder's file layout and content rules. Pure.
 *
 * A plugin's editable source is exactly two files. The model names one by a two-value
 * enum, so nothing is normalised, decoded or resolved: a path that isn't byte for byte
 * one of these strings fails the tool's schema before any code sees it. There is no
 * filesystem behind them either; the working copy is a JSON map in the run row.
 * `plugin.manifest.json` is not editable: it is generated from the stamped manifest.
 */
import { STUDIO_BUILDER_FILE_MAX_BYTES } from '../limits'

export const PLUGIN_PATHS = ['views/student.tsx', 'views/professor.tsx'] as const
export type PluginPath = (typeof PLUGIN_PATHS)[number]

export const VIEW_OF: Record<PluginPath, 'student' | 'professor'> = {
  'views/student.tsx': 'student',
  'views/professor.tsx': 'professor',
}

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

// Trojan Source: bidirectional overrides and isolates. Real right-to-left text needs none.
const BIDI = /[‪-‮⁦-⁩]/
// C0 and C1 controls other than tab, newline and carriage return, plus DEL.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/

export type ContentProblem = { code: 'bad_characters'; detail: string } | { code: 'file_too_large'; detail: string }

/** The first character rule this text breaks, named by code point and line, or null. */
export function characterProblem(text: string): string | null {
  if (!text.isWellFormed()) return 'a lone surrogate (text that is not valid Unicode)'
  for (const [pattern] of [[BIDI], [CONTROL]] as const) {
    const m = pattern.exec(text)
    if (m) {
      const line = text.slice(0, m.index).split('\n').length
      return `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} on line ${line}`
    }
  }
  return null
}

/** A leading byte-order mark is never meaningful in a view: the one rewrite, before hashing. */
export const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/** Whether a whole view file may be stored. */
export function viewContentProblem(text: string): ContentProblem | null {
  const chars = characterProblem(text)
  if (chars) return { code: 'bad_characters', detail: chars }
  const size = utf8Bytes(text)
  if (size > STUDIO_BUILDER_FILE_MAX_BYTES) {
    return { code: 'file_too_large', detail: `${size} bytes; a view is at most ${STUDIO_BUILDER_FILE_MAX_BYTES}` }
  }
  return null
}

/** Every string inside a JSON value (keys too), for the manifest's character rule. */
export function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const v of value) yield* stringsIn(v)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      yield k
      yield* stringsIn(v)
    }
  }
}
