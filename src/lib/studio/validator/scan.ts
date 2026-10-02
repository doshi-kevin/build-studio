/**
 * Reads plugin code without running it: bounded parsing with the TypeScript compiler
 * API, and an iterative walk that records what the code mentions. Nothing here
 * evaluates plugin code, and nothing may (a tripwire test enforces it).
 *
 * Bounds, in this order: byte size (artifact.size), bracket nesting from a linear
 * pre-scan, then a node count and a deadline during the walk. The pre-scan stops most
 * deep input before the parser. What it misses (nesting inside a regex literal) makes
 * the parser overflow its stack in about a millisecond; that is caught and fails the
 * check as a syntax error.
 *
 * What this can't promise: a determined author can hide behavior from any scanner
 * (encoded strings, indirection through objects and functions). These findings filter
 * honest mistakes and lazy attacks. The sandbox, the security policy, the host and the
 * server remain the boundaries (docs/reference/studio-plugin-validator.md, "What the
 * validator can't see").
 */
import ts from 'typescript'
import { STUDIO_VALIDATOR_MAX_NESTING, STUDIO_VALIDATOR_MAX_NODES, STUDIO_VALIDATOR_QUOTE_MAX_CHARS } from '../limits'

export type FindingKind =
  | 'navigation'
  | 'global_indirection'
  | 'html_injection'
  | 'dynamic_code'
  | 'network'
  | 'storage'
  | 'workers'
  | 'device_apis'
  | 'bridge_bypass'
  | 'bridge_call'
  | 'bridge_computed'
  | 'external_url'
  | 'module_syntax'
  | 'jsx'
  | 'intrinsic_element'
  | 'dom_building'
  | 'style_prop'
  | 'color_literal'
  | 'answer_key'

export interface Finding {
  kind: FindingKind
  line: number
  /** A short, sanitized quote: an API or property name, a method, a URL host. */
  detail: string
}

export type ScanResult =
  | { ok: true; findings: Finding[]; kitNames: Set<string> }
  | { ok: false; reason: 'too_deep' | 'too_many_nodes' | 'syntax' | 'timeout'; detail: string }

/** Strips control characters and clamps, so a quoted name can't break a log or a UI. */
export function quote(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').slice(0, STUDIO_VALIDATOR_QUOTE_MAX_CHARS)
}

/** Deepest bracket nesting, skipping strings and comments. Linear, no recursion. Inside
 * a template literal, each `${` opens a level and its `}` returns to the template. An
 * approximation is fine: it only has to stop inputs deep enough to hurt the parser.
 * Regex literals aren't recognized; nesting hidden in one reaches the parser, whose own
 * stack overflow is caught in scanCode and fails the check as a syntax error. */
export function maxNesting(code: string): number {
  let depth = 0
  let max = 0
  // The depth at which each open template substitution started.
  const substitutions: number[] = []
  let i = 0
  const open = () => {
    depth += 1
    if (depth > max) max = depth
  }
  // From just inside a template, to its closing backtick or the `{` of its next `${`.
  const skipTemplate = () => {
    for (; i < code.length; i += 1) {
      if (code[i] === '\\') i += 1
      else if (code[i] === '`') return
      else if (code[i] === '$' && code[i + 1] === '{') {
        i += 1
        open()
        substitutions.push(depth)
        return
      }
    }
  }
  for (; i < code.length; i += 1) {
    const c = code[i]
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      i = end === -1 ? code.length : end
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end === -1 ? code.length : end + 1
    } else if (c === '"' || c === "'") {
      for (i += 1; i < code.length && code[i] !== c; i += 1) if (code[i] === '\\') i += 1
    } else if (c === '`') {
      i += 1
      skipTemplate()
    } else if (c === '}' && substitutions.length > 0 && substitutions[substitutions.length - 1] === depth) {
      substitutions.pop()
      depth -= 1
      i += 1
      skipTemplate()
    } else if (c === '(' || c === '[' || c === '{') {
      open()
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1)
    }
  }
  return max
}

// ── What the code may not mention ─────────────────────────────────────

const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames', 'opener', 'document'])
const NAV_LOCATION_PROPS = new Set(['href', 'pathname', 'search', 'host', 'hostname', 'protocol', 'port', 'origin'])
const NAV_CALLS = new Set(['assign', 'replace', 'reload'])
const NAV_ATTRIBUTES = new Set(['href', 'action', 'formaction', 'src', 'srcdoc', 'http-equiv'])
const HTML_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc'])
const HTML_CALLS = new Set(['insertAdjacentHTML', 'write', 'writeln', 'createContextualFragment', 'parseFromString'])
const NETWORK = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'WebTransport'])
const STORAGE = new Set(['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookie', 'cookieStore'])
const WORKERS = new Set(['Worker', 'SharedWorker', 'serviceWorker', 'importScripts', 'Worklet', 'audioWorklet', 'paintWorklet'])
const DEVICE = new Set([
  'mediaDevices', 'getUserMedia', 'geolocation', 'clipboard', 'Notification', 'PaymentRequest', 'bluetooth', 'usb',
  'serial', 'hid', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel',
])
const DOM_BUILDING = new Set([
  'createElement', 'createElementNS', 'appendChild', 'insertBefore', 'replaceChildren', 'replaceChild', 'append',
  'prepend', 'before', 'after', 'attachShadow', 'createTextNode',
])
const COLOR_PROPS = /^(color|background|backgroundColor|borderColor|border|fill|stroke|outline|outlineColor|boxShadow|textShadow|caretColor|accentColor|textDecorationColor)$/
const COLOR_VALUE = /(#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklch|oklab|color)\s*\(|\b(red|blue|green|black|white|gray|grey|orange|purple|yellow|pink|navy|teal)\b)/
const ANSWER_KEY_PROPS = /^(correct|correctAnswer|correctAnswers|correctOption|answer|answers|answerKey|answerKeys|solution|solutions|rightAnswer|isCorrect|expected|expectedAnswer)$/i
const ABSOLUTE_URL = /^(https?:|wss?:|ftp:|data:|blob:|javascript:|vbscript:|\/\/[^/])/i
const BRIDGE_CALLEES = new Set(['request', 'useRequest'])
const ELEMENT_FACTORIES = new Set(['h', 'createElement', 'jsx', 'jsxs'])

/** The name a property access resolves to: `a.b` and `a['b']` both give "b". */
function propertyName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
  return null
}

/** `location`, `window.location`, `document.location`, `top['location']`... */
function isLocation(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'location'
  return propertyName(node) === 'location'
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string | null {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  return propertyName(e)
}

function isLiteral(node: ts.Expression): boolean {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return true
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isArrayLiteralExpression(node)) return node.elements.length > 0 && node.elements.every((el) => isLiteral(el as ts.Expression))
  return false
}

function isAsync(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false)
}

/** TypeScript-only syntax (types, enums, interfaces, `declare`, access modifiers): the
 * parser accepts it in a .js file without a diagnostic, and the browser refuses it. Only
 * a program reports it. The program holds this one file, with no lib and no resolution,
 * and nothing is type-checked. */
function typeScriptOnly(sf: ts.SourceFile): readonly ts.Diagnostic[] {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sf.fileName ? sf : undefined),
    fileExists: (name) => name === sf.fileName,
    readFile: () => undefined,
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  const program = ts.createProgram({ rootNames: [sf.fileName], options: { allowJs: true, noLib: true, noResolve: true, types: [] }, host })
  return program.getSyntacticDiagnostics(sf)
}

/** Parse and walk one bundle. `deadline` is an absolute Date.now() value. */
export function scanCode(code: string, deadline: number): ScanResult {
  const nesting = maxNesting(code)
  if (nesting > STUDIO_VALIDATOR_MAX_NESTING) return { ok: false, reason: 'too_deep', detail: `nesting ${nesting}` }

  let sf: ts.SourceFile
  try {
    sf = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  } catch (error) {
    // A RangeError from the parser's own recursion is caught here, not by the process.
    return { ok: false, reason: 'syntax', detail: quote(error instanceof Error ? error.name : 'parse failure') }
  }
  // Syntax errors: the parser recovers and records them on the source file, in a property
  // TypeScript doesn't export. If a TypeScript upgrade ever removes it, fail closed rather
  // than treating every bundle as valid.
  const diagnostics = (sf as unknown as { parseDiagnostics?: unknown }).parseDiagnostics
  if (!Array.isArray(diagnostics)) return { ok: false, reason: 'syntax', detail: 'parser diagnostics unavailable' }
  const syntaxError = (first: ts.Diagnostic): ScanResult => {
    const line = first.start !== undefined ? sf.getLineAndCharacterOfPosition(first.start).line + 1 : 0
    return { ok: false, reason: 'syntax', detail: `line ${line}` }
  }
  if (diagnostics.length > 0) return syntaxError(diagnostics[0] as ts.Diagnostic)

  const findings: Finding[] = []
  const kitNames = new Set<string>()
  const add = (kind: FindingKind, node: ts.Node, detail: string) =>
    findings.push({ kind, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, detail: quote(detail) })

  // Each node carries whether it sits in an async function's own body, for `await`.
  const stack: { node: ts.Node; inAsync: boolean }[] = [{ node: sf, inAsync: false }]
  let visited = 0
  while (stack.length > 0) {
    const { node, inAsync } = stack.pop()!
    visited += 1
    if (visited > STUDIO_VALIDATOR_MAX_NODES) return { ok: false, reason: 'too_many_nodes', detail: `${visited} nodes` }
    if (visited % 2048 === 0 && Date.now() > deadline) return { ok: false, reason: 'timeout', detail: `${visited} nodes` }
    inspect(node, inAsync)
    // A class field or static block allows no `await`, even inside an async function.
    const childAsync = ts.isFunctionLike(node) ? isAsync(node) : ts.isPropertyDeclaration(node) || ts.isClassStaticBlockDeclaration(node) ? false : inAsync
    node.forEachChild((child) => {
      // A computed key runs in the enclosing scope. Parameters never allow `await`.
      stack.push({ node: child, inAsync: ts.isComputedPropertyName(child) ? inAsync : ts.isParameter(child) ? false : childAsync })
    })
  }

  // Last, once the walk has bounded the tree: TypeScript-only syntax.
  let typeScript: readonly ts.Diagnostic[]
  try {
    typeScript = typeScriptOnly(sf)
  } catch (error) {
    return { ok: false, reason: 'syntax', detail: quote(error instanceof Error ? error.name : 'parse failure') }
  }
  if (typeScript.length > 0) return syntaxError(typeScript[0])
  return { ok: true, findings, kitNames }

  function inspect(node: ts.Node, inAsync: boolean) {
    // Module syntax and JSX: a bundle is one compiled classic script, which refuses all of
    // these at any depth. `export const x` is an export modifier on the declaration, not an
    // export declaration, so the modifier itself is what's matched.
    if (
      ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) || ts.isNamespaceExportDeclaration(node)
    ) {
      return add('module_syntax', node, 'import or export')
    }
    if (node.kind === ts.SyntaxKind.ExportKeyword) return add('module_syntax', node, 'export')
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) return add('module_syntax', node, 'import.meta')
    // A classic script has no top-level await. `await using` is a declaration list flag,
    // not an AwaitExpression.
    const awaitUsing = ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.AwaitUsing
    if (!inAsync && (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier) || awaitUsing)) {
      add('module_syntax', node, 'await outside an async function')
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return add('jsx', node, 'JSX')
    if (node.kind === ts.SyntaxKind.WithStatement) return add('global_indirection', node, 'with')

    // Names the code reads.
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const isPropertyName =
        (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (parent && (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
      if (!isPropertyName) {
        const name = node.text
        // Destructured kit names count too: `const { Loading } = ScholeraKit`.
        kitNames.add(name)
        if (NETWORK.has(name)) add('network', node, name)
        if (STORAGE.has(name)) add('storage', node, name)
        if (WORKERS.has(name)) add('workers', node, name)
        if (DEVICE.has(name)) add('device_apis', node, name)
        if (name === 'eval') add('dynamic_code', node, 'eval')
        if (name === 'Function' && !(parent && ts.isPropertyAccessExpression(parent))) add('dynamic_code', node, 'Function')
        if (name === 'parent' || name === 'top' || name === 'opener') add('bridge_bypass', node, name)
      }
    }

    // Property reads: `x.fetch`, `navigator.geolocation`, `document.cookie`, `ScholeraKit.Loading`.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = propertyName(node)
      if (name) {
        if (NETWORK.has(name)) add('network', node, name)
        if (STORAGE.has(name)) add('storage', node, name)
        if (WORKERS.has(name)) add('workers', node, name)
        if (DEVICE.has(name)) add('device_apis', node, name)
        if (name === 'parent' || name === 'top' || name === 'opener') add('bridge_bypass', node, name)
        if (name === 'postMessage') add('bridge_bypass', node, 'postMessage')
        kitNames.add(name)
      } else if (ts.isElementAccessExpression(node)) {
        // `window[x]`: computed access on a browser global hides which global it reaches.
        const target = node.expression
        if (ts.isIdentifier(target) && (GLOBAL_OBJECTS.has(target.text) || target.text === 'location')) {
          add('global_indirection', node, `${target.text}[…]`)
        }
      }
    }

    // Writes: `location = …`, `location.href = …`, `a.href = …`, `el.innerHTML = …`.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = node.left
      if (isLocation(left)) add('navigation', left, 'location')
      const name = propertyName(left)
      if (name && (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))) {
        if (NAV_LOCATION_PROPS.has(name) && isLocation(left.expression)) add('navigation', left, `location.${name}`)
        else if (name === 'href' || name === 'action') add('navigation', left, `.${name}`)
        if (HTML_PROPS.has(name)) add('html_injection', left, name)
        if (name === 'cookie') add('storage', left, 'cookie')
      }
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node)
      const args = node.arguments ?? ts.factory.createNodeArray()
      const e = node.expression
      const owner = ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? e.expression : null

      if (name && NAV_CALLS.has(name) && owner && isLocation(owner)) add('navigation', node, `location.${name}`)
      if (name === 'open' && (ts.isIdentifier(e) || (owner && ts.isIdentifier(owner) && GLOBAL_OBJECTS.has(owner.text)))) {
        add('navigation', node, 'window.open')
      }
      if (name === 'submit' || name === 'requestSubmit') add('navigation', node, name)
      if (name === 'setAttribute' && args[0] && ts.isStringLiteralLike(args[0]) && NAV_ATTRIBUTES.has(args[0].text.toLowerCase())) {
        add('navigation', node, `setAttribute(${args[0].text})`)
      }
      if (name && HTML_CALLS.has(name)) add('html_injection', node, name)
      if (name === 'Function' || (name === 'constructor' && args.length > 0)) add('dynamic_code', node, name)
      if ((name === 'setTimeout' || name === 'setInterval') && args[0] && (ts.isStringLiteralLike(args[0]) || ts.isTemplateExpression(args[0]))) {
        add('dynamic_code', node, `${name}(string)`)
      }
      if (e.kind === ts.SyntaxKind.ImportKeyword) add('dynamic_code', node, 'import()')
      if (name === 'require') add('module_syntax', node, 'require')
      if (name && (name === 'get' || name === 'apply' || name === 'getOwnPropertyDescriptor' || name === 'getOwnPropertyDescriptors') && args[0] && ts.isIdentifier(args[0]) && (GLOBAL_OBJECTS.has(args[0].text) || args[0].text === 'location')) {
        add('global_indirection', node, `${name}(${args[0].text})`)
      }
      if (name && DOM_BUILDING.has(name) && owner) add('dom_building', node, name)
      if (name === 'createElement' && args[0] && ts.isStringLiteralLike(args[0]) && args[0].text.toLowerCase() === 'script') {
        add('dynamic_code', node, 'createElement(script)')
      }
      // Raw HTML elements through the element factory: `h('div', …)`.
      if (name && ELEMENT_FACTORIES.has(name) && args[0] && ts.isStringLiteralLike(args[0])) {
        add('intrinsic_element', node, `<${args[0].text}>`)
      }
      // Bridge calls: `ScholeraStudio.request('records.list')`, `useRequest(...)`.
      if (name && BRIDGE_CALLEES.has(name)) {
        if (args[0] && ts.isStringLiteralLike(args[0])) add('bridge_call', node, args[0].text)
        else if (args[0]) add('bridge_computed', node, name)
      }
    }

    // Object literals: style props, color values, answer-key-shaped data.
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : null
      if (key) {
        if (key === 'style' || key === 'className' || key === 'class') add('style_prop', node, key)
        if (key === 'dangerouslySetInnerHTML') add('html_injection', node, key)
        if (COLOR_PROPS.test(key) && ts.isStringLiteralLike(node.initializer) && COLOR_VALUE.test(node.initializer.text)) {
          add('color_literal', node, `${key}: ${node.initializer.text}`)
        }
        if (ANSWER_KEY_PROPS.test(key) && isLiteral(node.initializer)) add('answer_key', node, key)
      }
    }

    // Strings that are URLs.
    if (ts.isStringLiteralLike(node) && ABSOLUTE_URL.test(node.text.trim())) {
      const host = /^[a-z]+:\/\/([^/?#]+)/i.exec(node.text.trim())?.[1] ?? node.text.trim().slice(0, 20)
      add('external_url', node, host)
    }
  }
}
