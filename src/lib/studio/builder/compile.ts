/**
 * The builder's compiler: the plugin package's TypeScript to the three bundles that run.
 * Scholera owns this step. The model writes source; it never supplies a bundle, and
 * nothing else in the builder produces one.
 *
 *   views/student.tsx, views/professor.tsx   one classic-script bundle each, for the frame
 *   server/index.ts                          one script for the plugin server runtime
 *
 * Each bundle is one strict IIFE. A view binds each kit name it imports to the frozen
 * `ScholeraKit` global and ends by mounting its default export with `ScholeraKit.render`.
 * JSX compiles to `ScholeraKit.h`, so there is no local factory a plugin could shadow.
 * Plugin-local imports are linked here, not at run time: every module the entry reaches
 * becomes a function, run once in dependency order, whose exports the importing module
 * binds by name. There is no loader, no `require` and no path lookup in any bundle. A view
 * with no local imports compiles to exactly the bytes it did before packages existed.
 *
 * The import boundary, checked on every import:
 *   views/*   may import views/*, shared/*, "react" and "@scholera/plugin-kit"
 *   shared/*  may import shared/* only (it runs in both places)
 *   server/*  may import server/*, shared/* and types from "@scholera/plugin-server"
 * A view never imports server code: it calls a server action through the Bridge.
 *
 * Nothing here runs plugin code: TypeScript only parses and prints. A postcondition
 * parses each bundle the way the validator's scan does; a violation there is a compiler
 * fault (CompilerFault), never a finding the model can repair around.
 *
 * Runs inside the check worker. Pure apart from the `typescript` import.
 */
import ts from 'typescript'
import { KIT_IMPORTS, KIT_TYPE_NAMES, type KitModule } from '../kit/plugin-kit-types'
import { STUDIO_BUILDER_DIAGNOSTICS_MAX, STUDIO_BUILDER_MESSAGE_MAX_CHARS, STUDIO_BUNDLE_MAX_BYTES } from '../limits'
import { fileClass, PLUGIN_PATHS, SERVER_ENTRY, utf8Bytes, type FileClass, type PluginPath, type ViewEntryPath } from './paths'

/** Part of every snapshot's hash, so a TypeScript upgrade can't reuse stored bundles.
 * Unchanged by packages: an entry with no local imports compiles to the same bytes. */
export const COMPILER_ID = `studio-tsx-v1+ts${ts.version}`

const RESERVED = 'ScholeraKit'
/** Names the linker gives modules (__studio_m1, ...). Plugin code may not use them. */
const LINK_PREFIX = '__studio'
const LINK_NAME = /^__studio_m\d+$/
const SERVER_TYPES_MODULE = '@scholera/plugin-server'

export interface SourceDiagnostic {
  file: PluginPath
  line: number | null
  code: string
  message: string
}

export type CompileResult = { ok: true; bundle: string } | { ok: false; diagnostics: SourceDiagnostic[] }

export interface PackageCompileResult {
  ok: boolean
  /** Every problem in the package, each reported once, capped. */
  diagnostics: SourceDiagnostic[]
  /** Present when every entry linked. `server` is null for a package without server code. */
  bundles: { student: string; professor: string; server: string | null } | null
  /** The keys of server/index.ts's `export const actions = { ... }` literal, or null when
   * there is no server entry or its actions aren't a plain object literal. */
  serverActions: string[] | null
}

/** The bundle broke the runtime contract. A bug in this file, not in the plugin. */
export class CompilerFault extends Error {
  constructor(reason: string) {
    super(`compiler postcondition: ${reason}`)
    this.name = 'CompilerFault'
  }
}

const clamp = (s: string) => s.slice(0, STUDIO_BUILDER_MESSAGE_MAX_CHARS)

type Binding = { local: string; line: number; from: { kind: 'kit'; name: string } | { kind: 'module'; path: string; name: string | null } }

/** One source file, read once: its imports, exports and problems. */
interface ModuleInfo {
  path: string
  source: string
  diagnostics: SourceDiagnostic[]
  /** Value bindings, in source order. A null name binds the whole module (import * as X). */
  bindings: Binding[]
  /** Plugin-local files this one imports, in source order. */
  deps: { path: string; node: ts.Node }[]
  /** Exported name -> local name, for values. */
  valueExports: Map<string, string>
  typeExports: Set<string>
  /** The named default function, for a view entry. */
  root: string | null
  /** The server entry's action names, when `actions` is an object literal. */
  actionNames: string[] | null
  sf: ts.SourceFile
}

const isEntry = (path: string) => (PLUGIN_PATHS as readonly string[]).includes(path)

/** May a file of class `from` import a file of class `to`? */
const MAY_IMPORT: Record<FileClass, readonly FileClass[]> = {
  views: ['views', 'shared'],
  shared: ['shared'],
  server: ['server', 'shared'],
}

function resolveRelative(from: string, spec: string, files: Readonly<Record<string, string>>): string | null {
  const parts = from.split('/').slice(0, -1)
  for (const segment of spec.split('/')) {
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  const base = parts.join('/')
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (Object.hasOwn(files, candidate)) return candidate
  return null
}

function analyze(path: string, source: string, files: Readonly<Record<string, string>>): ModuleInfo {
  const tsx = path.endsWith('.tsx')
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.ES2020, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const info: ModuleInfo = { path, source, diagnostics: [], bindings: [], deps: [], valueExports: new Map(), typeExports: new Set(), root: null, actionNames: null, sf }
  const report = (node: ts.Node | null, code: string, message: string) => {
    if (info.diagnostics.length >= STUDIO_BUILDER_DIAGNOSTICS_MAX) return
    const line = node ? sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 : null
    info.diagnostics.push({ file: path, line, code, message: clamp(message) })
  }

  // Syntax errors first: everything after needs a sound tree.
  const syntax = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics
  if (!Array.isArray(syntax)) throw new CompilerFault('parser diagnostics unavailable')
  for (const d of syntax.slice(0, STUDIO_BUILDER_DIAGNOSTICS_MAX)) {
    info.diagnostics.push({
      file: path,
      line: d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start).line + 1 : null,
      code: `TS${d.code}`,
      message: clamp(ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    })
  }
  if (info.diagnostics.length > 0) return info

  const cls = fileClass(path)
  const entry = isEntry(path)
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  // Values this file declares itself. Ambient (declare) declarations emit nothing, so they aren't values.
  const valueNames = new Set<string>()
  for (const s of sf.statements) {
    const ambient = ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
    if (ambient) continue
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) valueNames.add(s.name.text)
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) valueNames.add(d.name.text)
  }

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const spec = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''
      const clause = statement.importClause
      if (!clause) {
        report(statement, 'builder.import', 'Side-effect imports are not allowed. Import named members.')
        continue
      }
      if (clause.isTypeOnly) continue
      const relative = spec.startsWith('./') || spec.startsWith('../')

      if (spec === SERVER_TYPES_MODULE) {
        if (cls !== 'server') report(statement, 'builder.import', `Only server files import "${SERVER_TYPES_MODULE}".`)
        else if (clause.name || (clause.namedBindings && (!ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.some((e) => !e.isTypeOnly)))) {
          report(statement, 'builder.import', `"${SERVER_TYPES_MODULE}" has types only: write import type { ActionContext } from "${SERVER_TYPES_MODULE}". The runtime passes ctx to each action.`)
        }
        continue
      }

      if (!relative) {
        if (!Object.hasOwn(KIT_IMPORTS, spec)) {
          report(statement, 'builder.import', `Import only from "react", "@scholera/plugin-kit" or the tool's own files (like "./components/QuestionCard"), not "${spec.slice(0, 60)}".`)
          continue
        }
        if (cls !== 'views') {
          report(statement, 'builder.import', `Only files under views/ import "${spec}". ${cls === 'shared' ? 'shared/ files are plain TypeScript both sides use.' : 'Server code has no UI.'}`)
          continue
        }
        if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
          report(statement, 'builder.import', 'Use named imports only, like import { Button } from "@scholera/plugin-kit".')
          continue
        }
        const allowed = KIT_IMPORTS[spec as KitModule] as readonly string[]
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue
          const imported = (element.propertyName ?? element.name).text
          if (spec === '@scholera/plugin-kit' && (KIT_TYPE_NAMES as readonly string[]).includes(imported)) continue
          if (!allowed.includes(imported)) {
            report(element, 'builder.import', `"${imported.slice(0, 40)}" isn't exported by "${spec}". Allowed: ${allowed.join(', ')}.`)
            continue
          }
          info.bindings.push({ local: element.name.text, line: lineOf(element), from: { kind: 'kit', name: imported } })
        }
        continue
      }

      // A plugin-local module.
      const target = resolveRelative(path, spec, files)
      if (!target) {
        report(statement, 'builder.import', `"${spec.slice(0, 60)}" isn't a file of this tool. Import another file by its relative path without the extension, like "../shared/grading".`)
        continue
      }
      const targetClass = fileClass(target)
      if (!MAY_IMPORT[cls].includes(targetClass)) {
        report(
          statement,
          'builder.import_boundary',
          cls === 'views' && targetClass === 'server'
            ? `A view can't import server code (${target}). Call the action with request("server.call", { action, args }).`
            : `${cls}/ files can't import ${targetClass}/ files (${target}). views import views and shared; server imports server and shared; shared imports shared.`,
        )
        continue
      }
      if (isEntry(target) || target === SERVER_ENTRY) {
        report(statement, 'builder.import', `${target} is an entry and can't be imported. Move what you need into another file.`)
        continue
      }
      info.deps.push({ path: target, node: statement })
      if (clause.name) {
        report(statement, 'builder.import', 'The tool’s own files have named exports only: import { Name } from "./file".')
        continue
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        info.bindings.push({ local: clause.namedBindings.name.text, line: lineOf(statement), from: { kind: 'module', path: target, name: null } })
      } else if (clause.namedBindings) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue
          info.bindings.push({ local: element.name.text, line: lineOf(element), from: { kind: 'module', path: target, name: (element.propertyName ?? element.name).text } })
        }
      }
      continue
    }

    if (ts.isExportAssignment(statement)) {
      report(statement, 'builder.export', entry ? 'The only export allowed is one "export default function ViewName() { ... }".' : 'Use named exports: export function name() { ... }.')
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      if (entry || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        report(statement, 'builder.export', entry ? 'The only export allowed is one "export default function ViewName() { ... }".' : 'Export declarations directly (export function name), or list local names: export { a, b }. Re-exports are not allowed.')
        continue
      }
      for (const e of statement.exportClause.elements) {
        const local = (e.propertyName ?? e.name).text
        const imported = info.bindings.some((b) => b.local === local)
        if (statement.isTypeOnly || e.isTypeOnly || (!valueNames.has(local) && !imported)) info.typeExports.add(e.name.text)
        else info.valueExports.set(e.name.text, local)
      }
      continue
    }
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    if (!exported) continue
    if (entry) {
      if (ts.isFunctionDeclaration(statement) && isDefault && statement.name && info.root === null) {
        info.root = statement.name.text
      } else if (ts.isFunctionDeclaration(statement) && isDefault && !statement.name) {
        report(statement, 'builder.export', 'Give the default export a name: export default function StudentView() { ... }.')
      } else {
        report(statement, 'builder.export', 'The only export allowed is one "export default function ViewName() { ... }". Put shared components in another file under views/.')
      }
      continue
    }
    if (isDefault) {
      report(statement, 'builder.export', 'Use named exports: export function name() { ... }. Only the two view entries have a default export.')
      continue
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) info.typeExports.add(statement.name.text)
      else report(statement, 'builder.export', 'Ambient declarations (declare) emit no code. Export a real value.')
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      info.valueExports.set(statement.name.text, statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        let init = d.initializer
        while (init && (ts.isSatisfiesExpression(init) || ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression
        if (path === SERVER_ENTRY && ts.isIdentifier(d.name) && d.name.text === 'actions' && init && ts.isObjectLiteralExpression(init) && init.properties.every((p) => !ts.isSpreadAssignment(p))) {
          info.actionNames = init.properties.flatMap((p) =>
            (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : [],
          )
        }
        if (ts.isIdentifier(d.name)) info.valueExports.set(d.name.text, d.name.text)
        else report(d, 'builder.export', 'Export plain names, not destructuring patterns.')
      }
    } else {
      report(statement, 'builder.export', 'Export functions, constants, classes, enums, interfaces or types.')
    }
  }
  if (entry && info.root === null && !info.diagnostics.some((d) => d.code === 'builder.export')) {
    report(null, 'builder.export', 'The view needs one "export default function ViewName() { ... }".')
  }
  if (path === SERVER_ENTRY && !info.valueExports.has('actions') && !info.diagnostics.some((d) => d.code === 'builder.export')) {
    report(null, 'builder.server_actions', 'server/index.ts must export the actions: export const actions = { submitAttempt, ... }.')
  }

  // The reserved global may not be named anywhere: shadowing it would break the bundle,
  // and reaching it directly would skip the import allowlist. Module loading in any
  // other form is the plugin's mistake, reported like one, so the postcondition below
  // only ever catches a fault of ours.
  const walk = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === RESERVED) report(node, 'builder.reserved', `"${RESERVED}" is reserved. Import what you need instead.`)
    if (ts.isIdentifier(node) && LINK_NAME.test(node.text)) report(node, 'builder.reserved', `"${node.text}" is a name Studio's linker uses. Rename it.`)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      report(node, 'builder.import', 'Load nothing at run time. Import named members at the top of the file.')
    }
    if (ts.isModuleDeclaration(node)) report(node, 'builder.export', `Namespaces and module declarations are not allowed in a ${cls === 'views' ? 'view' : 'tool file'}.`)
    node.forEachChild(walk)
  }
  walk(sf)
  return info
}

const stripModifiers = (node: ts.Node): ts.Node => {
  if (!ts.canHaveModifiers(node)) return node
  const modifiers = ts.getModifiers(node)
  if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword)) return node
  return ts.factory.replaceModifiers(node as ts.HasModifiers, modifiers.filter((m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword))
}

/** One module's code without its imports and exports, as plain statements. */
function transpile(info: ModuleInfo): { ok: true; code: string } | { ok: false; diagnostics: SourceDiagnostic[] } {
  // Imports go (each name is bound by the linker); declarations lose their export
  // modifiers; export lists go (the linker returns them); TypeScript's trailing `export {}` goes too.
  const before: ts.TransformerFactory<ts.SourceFile> = () => (file) =>
    ts.factory.updateSourceFile(
      file,
      file.statements
        .filter((s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s))
        .map((s) => stripModifiers(s) as ts.Statement),
    )
  const after: ts.TransformerFactory<ts.SourceFile> = () => (file) =>
    ts.factory.updateSourceFile(file, file.statements.filter((s) => !ts.isExportDeclaration(s)))

  const out = ts.transpileModule(info.source, {
    fileName: info.path,
    reportDiagnostics: true,
    transformers: { before: [before], after: [after] },
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
      jsxFactory: `${RESERVED}.h`,
      jsxFragmentFactory: `${RESERVED}.Fragment`,
      sourceMap: false,
      removeComments: true,
    },
  })
  const diagnostics = (out.diagnostics ?? []).slice(0, STUDIO_BUILDER_DIAGNOSTICS_MAX).map((d) => ({
    file: info.path,
    line: null,
    code: `TS${d.code}`,
    message: clamp(ts.flattenDiagnosticMessageText(d.messageText, ' ')),
  }))
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, code: out.outputText.trim() }
}

/** The modules an entry reaches, dependencies first; or the import that closes a cycle. */
function linkOrder(entry: string, modules: ReadonlyMap<string, ModuleInfo>): { ok: true; order: string[] } | { ok: false; diagnostic: SourceDiagnostic } {
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  let cycle: SourceDiagnostic | null = null
  const visit = (path: string) => {
    state.set(path, 'visiting')
    const info = modules.get(path)!
    for (const dep of info.deps) {
      if (cycle) return
      const s = state.get(dep.path)
      if (s === 'visiting') {
        const line = info.sf.getLineAndCharacterOfPosition(dep.node.getStart(info.sf)).line + 1
        cycle = { file: path, line, code: 'builder.import_cycle', message: clamp(`${path} and ${dep.path} import each other. Move what both need into a third file.`) }
        return
      }
      if (!s) visit(dep.path)
    }
    state.set(path, 'done')
    order.push(path)
  }
  visit(entry)
  return cycle ? { ok: false, diagnostic: cycle } : { ok: true, order }
}

const bindingLine = (b: Binding, ids: ReadonlyMap<string, string>) =>
  b.from.kind === 'kit'
    ? `var ${b.local} = ${RESERVED}.${b.from.name};`
    : `var ${b.local} = ${ids.get(b.from.path)}${b.from.name === null ? '' : `.${b.from.name}`};`

/** Every local name a module imports must be a value its target exports. */
function bindingProblems(info: ModuleInfo, modules: ReadonlyMap<string, ModuleInfo>): SourceDiagnostic[] {
  const out: SourceDiagnostic[] = []
  for (const b of info.bindings) {
    if (b.from.kind !== 'module' || b.from.name === null) continue
    const target = modules.get(b.from.path)!
    if (!target.valueExports.has(b.from.name) && !target.typeExports.has(b.from.name)) {
      out.push({ file: info.path, line: b.line, code: 'builder.import', message: clamp(`"${b.from.name}" isn't exported by ${b.from.path}.`) })
    }
  }
  return out
}

/** Link one entry into its bundle. The entry and every module it reaches already analyzed cleanly. */
function link(entry: string, modules: ReadonlyMap<string, ModuleInfo>, code: ReadonlyMap<string, string>): CompileResult {
  const ordered = linkOrder(entry, modules)
  if (!ordered.ok) return { ok: false, diagnostics: [ordered.diagnostic] }
  const ids = new Map(ordered.order.filter((p) => p !== entry).map((p, i) => [p, `${LINK_PREFIX}_m${i + 1}`]))
  const diagnostics = ordered.order.flatMap((p) => bindingProblems(modules.get(p)!, modules))
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  // A module binds only what it imports as a value; type-only names have nothing to bind.
  const prelude = (info: ModuleInfo) =>
    info.bindings
      .filter((b) => b.from.kind === 'kit' || b.from.name === null || modules.get(b.from.path)!.valueExports.has(b.from.name))
      .map((b) => bindingLine(b, ids))
      .join('\n')
  const isValue = (info: ModuleInfo, local: string) => {
    const b = info.bindings.find((x) => x.local === local)
    return !b || b.from.kind === 'kit' || b.from.name === null || modules.get(b.from.path)!.valueExports.has(b.from.name)
  }
  const exportsOf = (info: ModuleInfo) =>
    [...info.valueExports].filter(([, local]) => isValue(info, local)).map(([name, local]) => `${JSON.stringify(name)}: ${local}`).join(', ')
  const wrapped = [...ids].map(([path, id]) => {
    const info = modules.get(path)!
    const exports = exportsOf(info)
    const bindings = prelude(info)
    return `var ${id} = (function () {\n${bindings ? `${bindings}\n` : ''}${code.get(path)}\nreturn { ${exports} };\n})();`
  })
  const head = wrapped.length > 0 ? `${wrapped.join('\n')}\n` : ''
  const info = modules.get(entry)!
  const tail =
    entry === SERVER_ENTRY
      ? `return { ${exportsOf(info)} };`
      : `${RESERVED}.render(${RESERVED}.h(${info.root}, null));`
  const bundle = `'use strict';\n(function () {\n${head}${prelude(info)}\n${code.get(entry)}\n${tail}\n})();\n`

  if (utf8Bytes(bundle) > STUDIO_BUNDLE_MAX_BYTES) {
    return { ok: false, diagnostics: [{ file: entry, line: null, code: 'builder.size', message: `The compiled ${entry === SERVER_ENTRY ? 'server code' : 'view'} is larger than ${STUDIO_BUNDLE_MAX_BYTES} bytes.` }] }
  }
  assertClassicScript(bundle, entry === SERVER_ENTRY)
  return { ok: true, bundle }
}

/** Compile and link the whole package. `files` holds every source file by package path. */
export function compilePackage(files: Readonly<Record<string, string>>): PackageCompileResult {
  const modules = new Map<string, ModuleInfo>()
  const diagnostics: SourceDiagnostic[] = []
  const paths = Object.keys(files).sort()
  for (const p of paths) {
    const info = analyze(p, files[p], files)
    modules.set(p, info)
    diagnostics.push(...info.diagnostics)
  }
  for (const entry of PLUGIN_PATHS) {
    if (!Object.hasOwn(files, entry)) diagnostics.push({ file: entry, line: null, code: 'builder.export', message: 'This view doesn’t exist yet. Create it with write_file.' })
  }
  const hasServer = paths.some((p) => fileClass(p) === 'server')
  if (hasServer && !Object.hasOwn(files, SERVER_ENTRY)) {
    diagnostics.push({ file: SERVER_ENTRY, line: null, code: 'builder.server_actions', message: 'Server code needs its entry, server/index.ts, which exports the actions.' })
  }
  const code = new Map<string, string>()
  if (diagnostics.length === 0) {
    for (const p of paths) {
      const out = transpile(modules.get(p)!)
      if (out.ok) code.set(p, out.code)
      else diagnostics.push(...out.diagnostics)
    }
  }
  const serverActions = modules.get(SERVER_ENTRY)?.actionNames ?? null
  if (diagnostics.length > 0) return { ok: false, diagnostics: diagnostics.slice(0, STUDIO_BUILDER_DIAGNOSTICS_MAX), bundles: null, serverActions }

  const linked = {
    student: link('views/student.tsx', modules, code),
    professor: link('views/professor.tsx', modules, code),
    server: hasServer ? link(SERVER_ENTRY, modules, code) : null,
  }
  const failed = [linked.student, linked.professor, linked.server].flatMap((r) => (r && !r.ok ? r.diagnostics : []))
  if (failed.length > 0 || !linked.student.ok || !linked.professor.ok || (linked.server && !linked.server.ok)) {
    // The same cycle or missing name can surface from two entries: report it once.
    const seen = new Set<string>()
    const unique = failed.filter((d) => {
      const key = `${d.file}|${d.line}|${d.code}|${d.message}`
      return seen.has(key) ? false : (seen.add(key), true)
    })
    return { ok: false, diagnostics: unique.slice(0, STUDIO_BUILDER_DIAGNOSTICS_MAX), bundles: null, serverActions }
  }
  return {
    ok: true,
    diagnostics: [],
    bundles: { student: linked.student.bundle, professor: linked.professor.bundle, server: linked.server?.ok ? linked.server.bundle : null },
    serverActions,
  }
}

/** One view entry on its own, as before packages: the entry and nothing it imports. */
export function compileView(path: ViewEntryPath, source: string): CompileResult {
  const info = analyze(path, source, { [path]: source })
  if (info.diagnostics.length > 0) return { ok: false, diagnostics: info.diagnostics }
  const out = transpile(info)
  if (!out.ok) return out
  return link(path, new Map([[path, info]]), new Map([[path, out.code]]))
}

/** The runtime contract, checked the way the validator's scan parses bundles. A server
 * bundle must also never name the kit: it runs where there is none. */
export function assertClassicScript(bundle: string, server = false): void {
  const sf = ts.createSourceFile('bundle.js', bundle, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const parse = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics
  if (!Array.isArray(parse) || parse.length > 0) throw new CompilerFault('bundle does not parse')
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) throw new CompilerFault('module syntax in bundle')
    // `export const x` parses as a modifier on the statement, not an export declaration.
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) throw new CompilerFault('export in bundle')
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) throw new CompilerFault('JSX in bundle')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') throw new CompilerFault('require in bundle')
    if (server && ts.isIdentifier(node) && node.text === RESERVED) throw new CompilerFault('kit in server bundle')
    node.forEachChild(visit)
  }
  visit(sf)
}
