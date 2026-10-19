/**
 * The plugin package's file layout and content rules. Pure.
 *
 * A plugin's editable source is a package of up to STUDIO_PACKAGE_MAX_FILES TypeScript
 * files under three folders:
 *
 *   views/   the UI. views/student.tsx and views/professor.tsx are the two entries the
 *            platform mounts; anything else under views/ is a component or helper they import.
 *   shared/  plain TypeScript both the views and the server import: types, formulas, grading rules.
 *   server/  the plugin's own server code. server/index.ts is its entry and exports `actions`.
 *
 * A path is checked against one pattern, byte for byte: no normalising, decoding or
 * resolving, so "views/../x" or "Views/a.tsx" is simply not a path. There is no
 * filesystem behind them either; the working copy is a JSON map in the run row.
 * `plugin.manifest.json` is not editable: it is generated from the stamped manifest.
 */
import {
  STUDIO_BUILDER_FILE_MAX_BYTES,
  STUDIO_PACKAGE_MAX_BYTES,
  STUDIO_PACKAGE_MAX_FILES,
  STUDIO_PACKAGE_PATH_MAX_CHARS,
} from '../limits'

/** The two view entries every package has. */
export const PLUGIN_PATHS = ['views/student.tsx', 'views/professor.tsx'] as const
export type ViewEntryPath = (typeof PLUGIN_PATHS)[number]
/** Any file of the package; valid only once `packagePathProblem` returned null. */
export type PluginPath = string

export const VIEW_OF: Record<ViewEntryPath, 'student' | 'professor'> = {
  'views/student.tsx': 'student',
  'views/professor.tsx': 'professor',
}

/** The server entry: present exactly when the package has server code. */
export const SERVER_ENTRY = 'server/index.ts'

export type FileClass = 'views' | 'shared' | 'server'

// One optional sub-folder, then a name; letters, digits and hyphens; .tsx only under views/.
const PATH = /^(views|shared|server)\/(?:[a-z][a-z0-9-]{0,30}\/)?[A-Za-z][A-Za-z0-9-]{0,40}\.(ts|tsx)$/

export const fileClass = (path: string): FileClass => path.slice(0, path.indexOf('/')) as FileClass

/** Why this string isn't a package path, or null. */
export function packagePathProblem(path: string): string | null {
  if (path.length > STUDIO_PACKAGE_PATH_MAX_CHARS) return `a path is at most ${STUDIO_PACKAGE_PATH_MAX_CHARS} characters`
  const m = PATH.exec(path)
  if (!m) return 'paths look like views/student.tsx, views/components/QuestionCard.tsx, shared/grading.ts or server/index.ts'
  if (m[2] === 'tsx' && m[1] !== 'views') return 'only files under views/ may be .tsx'
  return null
}

export const isPackagePath = (path: string) => packagePathProblem(path) === null

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

/** A leading byte-order mark is never meaningful in a source file: the one rewrite, before hashing. */
export const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/** Whether a whole source file may be stored. */
export function viewContentProblem(text: string): ContentProblem | null {
  const chars = characterProblem(text)
  if (chars) return { code: 'bad_characters', detail: chars }
  const size = utf8Bytes(text)
  if (size > STUDIO_BUILDER_FILE_MAX_BYTES) {
    return { code: 'file_too_large', detail: `${size} bytes; a file is at most ${STUDIO_BUILDER_FILE_MAX_BYTES}` }
  }
  return null
}

/** Whether a package with these files fits its limits: file count and total size. */
export function packageSizeProblem(files: Readonly<Record<string, string | undefined>>): string | null {
  const present = Object.values(files).filter((t): t is string => typeof t === 'string')
  if (present.length > STUDIO_PACKAGE_MAX_FILES) return `${present.length} files; a tool has at most ${STUDIO_PACKAGE_MAX_FILES}`
  const total = present.reduce((n, t) => n + utf8Bytes(t), 0)
  if (total > STUDIO_PACKAGE_MAX_BYTES) return `${total} bytes in all; a tool's files total at most ${STUDIO_PACKAGE_MAX_BYTES}`
  return null
}

/** The package's paths in a fixed order: the two entries, then the rest by path. */
export function packagePaths(files: Readonly<Record<string, string | undefined>>): string[] {
  const rest = Object.keys(files).filter((p) => typeof files[p] === 'string' && !(PLUGIN_PATHS as readonly string[]).includes(p)).sort()
  return [...PLUGIN_PATHS.filter((p) => typeof files[p] === 'string'), ...rest]
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
