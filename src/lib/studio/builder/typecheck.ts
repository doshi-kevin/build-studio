/**
 * Typechecks the two views against the plugin environment (kit/plugin-kit-types.ts) and
 * nothing else. The compiler host is virtual: it serves the environment and the two view
 * files from memory and reports every other name as missing, so a triple-slash reference
 * or a `lib` directive can only produce a diagnostic, never pull in DOM or Node types.
 *
 * Developer feedback for the model, not a security boundary.
 *
 * Runs inside the check worker. Pure apart from the `typescript` import.
 */
import ts from 'typescript'
import { PLUGIN_ENV_DTS } from '../kit/plugin-kit-types'
import { STUDIO_BUILDER_DIAGNOSTICS_MAX, STUDIO_BUILDER_MESSAGE_MAX_CHARS } from '../limits'
import { PLUGIN_PATHS, type PluginPath } from './paths'
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

/** `files` must hold both views. */
export function typecheckViews(files: Record<PluginPath, string>): TypecheckResult {
  const served = new Map<string, string>([[ENV, PLUGIN_ENV_DTS], ...PLUGIN_PATHS.map((p) => [`/${p}`, files[p]] as [string, string])])
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
    directoryExists: (d) => d === '/' || d === '/views',
    getDirectories: () => [],
    realpath: (p) => p,
  }
  const program = ts.createProgram([ENV, ...PLUGIN_PATHS.map((p) => `/${p}`)], OPTIONS, host)
  const all = ts.getPreEmitDiagnostics(program)
  const diagnostics = all.slice(0, STUDIO_BUILDER_DIAGNOSTICS_MAX).map((d): SourceDiagnostic => {
    const name = d.file?.fileName.replace(/^\//, '')
    const file = (PLUGIN_PATHS as readonly string[]).includes(name ?? '') ? (name as PluginPath) : 'views/student.tsx'
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null
    return {
      file,
      line: d.file?.fileName === ENV ? null : line,
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, STUDIO_BUILDER_MESSAGE_MAX_CHARS),
    }
  })
  return { diagnostics, total: all.length }
}
