/**
 * Typechecks the package against the plugin environments and nothing else, in two
 * programs: the views with the shared files against the view environment (the language
 * core, JSX and the kit, kit/plugin-kit-types.ts), and the server files with the shared
 * files against the server environment (the language core and the types of
 * `@scholera/plugin-server`). Shared files are checked in both, so they can only use what
 * both sides have; a diagnostic they get twice is reported once. A view that imports
 * server code finds no such file here: the compiler reports the boundary itself.
 *
 * The compiler host is virtual: it serves the environment and the package from memory
 * and reports every other name as missing, so a triple-slash reference or a `lib`
 * directive can only produce a diagnostic, never pull in DOM or Node types.
 *
 * Developer feedback for the model, not a security boundary.
 *
 * Runs inside the check worker. Pure apart from the `typescript` import.
 */
import ts from 'typescript'
import { PLUGIN_CORE_DTS, PLUGIN_ENV_DTS } from '../kit/plugin-kit-types'
import { STUDIO_BUILDER_DIAGNOSTICS_MAX, STUDIO_BUILDER_MESSAGE_MAX_CHARS } from '../limits'
import { PLUGIN_SERVER_DTS } from '../server-runtime/plugin-server-types'
import { fileClass, SERVER_ENTRY, type PluginPath } from './paths'
import type { SourceDiagnostic } from './compile'

const ENV = '/plugin-env.d.ts'

const OPTIONS: ts.CompilerOptions = {
  noLib: true,
  types: [],
  strict: true,
  noUnusedLocals: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ES2015,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  allowJs: false,
  skipLibCheck: false,
  noResolve: false,
}

export interface TypecheckResult {
  diagnostics: SourceDiagnostic[]
  /** How many there were before the cap. */
  total: number
}

function program(env: string, files: Readonly<Record<string, string>>, roots: string[], fallback: PluginPath): { diagnostics: readonly ts.Diagnostic[]; fallback: PluginPath } {
  const served = new Map<string, string>([[ENV, env], ...roots.map((p) => [`/${p}`, files[p]] as [string, string])])
  const dirs = new Set(['/'])
  for (const p of roots) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(`/${parts.slice(0, i).join('/')}`)
  }
  const host: ts.CompilerHost = {
    getSourceFile: (name, version) => {
      const text = served.get(name)
      return text === undefined ? undefined : ts.createSourceFile(name, text, version, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    },
    getDefaultLibFileName: () => ENV,
    getDefaultLibLocation: () => '/__no_lib__',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => served.has(f),
    readFile: (f) => served.get(f),
    directoryExists: (d) => dirs.has(d),
    getDirectories: () => [],
    realpath: (p) => p,
  }
  return { diagnostics: ts.getPreEmitDiagnostics(ts.createProgram([ENV, ...roots.map((p) => `/${p}`)], OPTIONS, host)), fallback }
}

/** `files` holds every source file of the package, both view entries included. */
export function typecheckPackage(files: Readonly<Record<string, string>>): TypecheckResult {
  const paths = Object.keys(files).sort()
  const ofClass = (...classes: string[]) => paths.filter((p) => classes.includes(fileClass(p)))
  const programs = [program(PLUGIN_ENV_DTS, files, ofClass('views', 'shared'), 'views/student.tsx')]
  const server = ofClass('server')
  if (server.length > 0) programs.push(program(PLUGIN_CORE_DTS + PLUGIN_SERVER_DTS, files, [...server, ...ofClass('shared')], SERVER_ENTRY))
  const all = programs.flatMap((p) => p.diagnostics.map((d) => ({ d, fallback: p.fallback })))

  const seen = new Set<string>()
  const diagnostics: SourceDiagnostic[] = []
  let total = 0
  for (const { d, fallback } of all) {
    const name = d.file?.fileName.replace(/^\//, '')
    const file: PluginPath = name && Object.hasOwn(files, name) ? name : fallback
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, STUDIO_BUILDER_MESSAGE_MAX_CHARS)
    const key = `${file}|${line}|${d.code}|${message}`
    if (seen.has(key)) continue
    seen.add(key)
    total += 1
    if (diagnostics.length < STUDIO_BUILDER_DIAGNOSTICS_MAX) {
      diagnostics.push({ file, line: d.file?.fileName === ENV ? null : line, code: `TS${d.code}`, message })
    }
  }
  return { diagnostics, total }
}
