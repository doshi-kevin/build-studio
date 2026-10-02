/**
 * The builder's compiler: one view's TSX source to the classic-script bundle the Step 4
 * runtime runs. Scholera owns this step. The model writes source; it never supplies a
 * bundle, and nothing else in the builder produces one.
 *
 * The output has the canonical bundle shape (validator/fixtures.ts): one strict IIFE that
 * binds each imported name to the frozen `ScholeraKit` global, then mounts the view's
 * default export with `ScholeraKit.render`. JSX compiles to `ScholeraKit.h`, so there is
 * no local factory a plugin could shadow, and `ScholeraKit` itself is a reserved name.
 *
 * Nothing here runs plugin code: TypeScript only parses and prints. A postcondition
 * parses the bundle the way the validator's scan does; a violation there is a compiler
 * fault (CompilerFault), never a finding the model can repair around.
 *
 * Runs inside the check worker. Pure apart from the `typescript` import.
 */
import ts from 'typescript'
import { KIT_IMPORTS, KIT_TYPE_NAMES, type KitModule } from '../kit/plugin-kit-types'
import { STUDIO_BUILDER_DIAGNOSTICS_MAX, STUDIO_BUILDER_MESSAGE_MAX_CHARS, STUDIO_BUNDLE_MAX_BYTES } from '../limits'
import { utf8Bytes, type PluginPath } from './paths'

/** Part of every snapshot's hash, so a TypeScript upgrade can't reuse stored bundles. */
export const COMPILER_ID = `studio-tsx-v1+ts${ts.version}`

const RESERVED = 'ScholeraKit'

export interface SourceDiagnostic {
  file: PluginPath
  line: number | null
  code: string
  message: string
}

export type CompileResult = { ok: true; bundle: string } | { ok: false; diagnostics: SourceDiagnostic[] }

/** The bundle broke the runtime contract. A bug in this file, not in the plugin. */
export class CompilerFault extends Error {
  constructor(reason: string) {
    super(`compiler postcondition: ${reason}`)
    this.name = 'CompilerFault'
  }
}

const clamp = (s: string) => s.slice(0, STUDIO_BUILDER_MESSAGE_MAX_CHARS)

export function compileView(path: PluginPath, source: string): CompileResult {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX)
  const diagnostics: SourceDiagnostic[] = []
  const report = (node: ts.Node | null, code: string, message: string) => {
    if (diagnostics.length >= STUDIO_BUILDER_DIAGNOSTICS_MAX) return
    const line = node ? sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 : null
    diagnostics.push({ file: path, line, code, message: clamp(message) })
  }

  // Syntax errors first: everything after needs a sound tree.
  const syntax = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics
  if (!Array.isArray(syntax)) throw new CompilerFault('parser diagnostics unavailable')
  for (const d of syntax.slice(0, STUDIO_BUILDER_DIAGNOSTICS_MAX)) {
    diagnostics.push({
      file: path,
      line: d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start).line + 1 : null,
      code: `TS${d.code}`,
      message: clamp(ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    })
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  // Imports and exports: named imports from the two kit modules, one named default function.
  const bindings = new Map<string, string>()
  let root: string | null = null
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const spec = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''
      if (!Object.hasOwn(KIT_IMPORTS, spec)) {
        report(statement, 'builder.import', `Import only from "react" or "@scholera/plugin-kit", not "${spec.slice(0, 60)}".`)
        continue
      }
      const clause = statement.importClause
      if (!clause) {
        report(statement, 'builder.import', 'Side-effect imports are not allowed. Import named members.')
        continue
      }
      if (clause.isTypeOnly) continue
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
        bindings.set(element.name.text, imported)
      }
      continue
    }
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      report(statement, 'builder.export', 'The only export allowed is one "export default function ViewName() { ... }".')
      continue
    }
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    if (!exported) continue
    if (ts.isFunctionDeclaration(statement) && isDefault && statement.name && root === null) {
      root = statement.name.text
    } else if (ts.isFunctionDeclaration(statement) && isDefault && !statement.name) {
      report(statement, 'builder.export', 'Give the default export a name: export default function StudentView() { ... }.')
    } else {
      report(statement, 'builder.export', 'The only export allowed is one "export default function ViewName() { ... }".')
    }
  }
  if (root === null && !diagnostics.some((d) => d.code === 'builder.export')) {
    report(null, 'builder.export', 'The view needs one "export default function ViewName() { ... }".')
  }

  // The reserved global may not be named anywhere: shadowing it would break the bundle,
  // and reaching it directly would skip the import allowlist.
  // Module loading in any other form is the plugin's mistake, reported like one, so the
  // postcondition below only ever catches a fault of ours.
  const walk = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === RESERVED) report(node, 'builder.reserved', `"${RESERVED}" is reserved. Import what you need instead.`)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      report(node, 'builder.import', 'Load nothing at run time. Import named members from the kit at the top of the file.')
    }
    if (ts.isModuleDeclaration(node)) report(node, 'builder.export', 'Namespaces and module declarations are not allowed in a view.')
    node.forEachChild(walk)
  }
  walk(sf)
  if (diagnostics.length > 0 || root === null) return { ok: false, diagnostics }

  // Print. Imports go (each name is bound to the kit below); the default function keeps
  // its name and loses its export; TypeScript's trailing `export {}` goes too.
  const before: ts.TransformerFactory<ts.SourceFile> = () => (file) =>
    ts.factory.updateSourceFile(
      file,
      file.statements
        .filter((s) => !ts.isImportDeclaration(s))
        .map((s) =>
          ts.isFunctionDeclaration(s) && s.modifiers
            ? ts.factory.updateFunctionDeclaration(
                s,
                s.modifiers.filter((m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword),
                s.asteriskToken, s.name, s.typeParameters, s.parameters, s.type, s.body,
              )
            : s,
        ),
    )
  const after: ts.TransformerFactory<ts.SourceFile> = () => (file) =>
    ts.factory.updateSourceFile(file, file.statements.filter((s) => !ts.isExportDeclaration(s)))

  const out = ts.transpileModule(source, {
    fileName: path,
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
  for (const d of out.diagnostics ?? []) {
    report(null, `TS${d.code}`, ts.flattenDiagnosticMessageText(d.messageText, ' '))
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const prelude = [...bindings].map(([local, imported]) => `var ${local} = ${RESERVED}.${imported};`).join('\n')
  const bundle = `'use strict';\n(function () {\n${prelude}\n${out.outputText.trim()}\n${RESERVED}.render(${RESERVED}.h(${root}, null));\n})();\n`

  if (utf8Bytes(bundle) > STUDIO_BUNDLE_MAX_BYTES) {
    return { ok: false, diagnostics: [{ file: path, line: null, code: 'builder.size', message: `The compiled view is larger than ${STUDIO_BUNDLE_MAX_BYTES} bytes.` }] }
  }
  assertClassicScript(bundle)
  return { ok: true, bundle }
}

/** The runtime contract, checked the way the validator's scan parses bundles. */
export function assertClassicScript(bundle: string): void {
  const sf = ts.createSourceFile('bundle.js', bundle, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const parse = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics
  if (!Array.isArray(parse) || parse.length > 0) throw new CompilerFault('bundle does not parse')
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) throw new CompilerFault('module syntax in bundle')
    // `export const x` parses as a modifier on the statement, not an export declaration.
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) throw new CompilerFault('export in bundle')
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) throw new CompilerFault('JSX in bundle')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') throw new CompilerFault('require in bundle')
    node.forEachChild(visit)
  }
  visit(sf)
}
