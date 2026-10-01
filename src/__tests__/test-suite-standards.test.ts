/**
 * The test suite policing itself.
 *
 * An audit of all 570 test files (2026-09-15) found the suite already clean on every rule
 * below — zero `.only`, zero snapshots, one assertion-free test and four fixed sleeps, both
 * since fixed. So this file protects a property the suite ALREADY has rather than chasing one
 * it lacks, which is the cheapest moment to install a ratchet: nothing to clean up first, and
 * the next violation fails on the PR that introduces it instead of accumulating unnoticed.
 *
 * Each rule below is here because it makes a test unable to fail for the right reason:
 *   - `.only`         silently reduces the suite to one test; CI goes green having run nothing.
 *   - no assertion    the test passes by not crashing, so deleting the code under test passes too.
 *   - fixed sleep     races on a loaded machine and wastes wall-clock on a fast one.
 *   - snapshots       large diffs get approved without being read.
 *   - bare skip       a disabled test with no stated reason is never re-enabled.
 *
 * DELIBERATELY NOT a lint rule: these need the test BODY (does this block assert anything?),
 * which is a cross-line question ESLint's per-node model answers awkwardly. It is also the
 * established shape here — see admin-page-inline-authz-guard.test.ts and ai-call-site-coverage.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src', 'e2e']
const TEST_FILE = /\.(test|spec)\.tsx?$/

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...testFiles(full))
    else if (TEST_FILE.test(entry)) out.push(full)
  }
  return out
}

/**
 * Blank out comments, preserving line count so reported line numbers stay true.
 *
 * Line comments are stripped with a leading-whitespace anchor rather than anywhere-on-the-line.
 * An earlier version of this scan used the loose form and corrupted its own brace matching on
 * regex literals like `/\*[\s\S]*?\*\//g`, whose trailing `\//` reads as the start of a comment.
 */
function stripComments(src: string): string {
  return src
    .replace(/^(\s*)\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * A test DECLARATION: `it('…'`, `test.skip('…'`, `it.each([...])('…'`.
 *
 * The first argument must be a string or template literal. That is what separates a declaration
 * from `test.skip(!roomId, 'reason')` — Playwright's imperative mid-test skip, whose first
 * argument is a condition. Treating that as a declaration truncates the enclosing test's body at
 * the skip line and reports the test as assertion-free when it asserts plenty below.
 */
const TEST_START =
  /^\s*(?:it|test)(?:\.(?:skip|only|todo|concurrent|failing|fails|sequential))*\s*\(\s*['"`]|^\s*(?:it|test)\.each\b/
const DESCRIBE_START = /^\s*describe(?:\.\w+)*\s*\(\s*['"`]/

interface TestBlock {
  file: string
  line: number
  title: string
  body: string
}

/**
 * Split a file into test blocks by line range: each `it(` start line up to the next `it(` or
 * `describe(`. Deliberately NOT brace matching — brace counting has to survive template
 * literals, regex literals and nested arrow functions, and gets those wrong often enough to
 * report false violations, which is the one thing a tripwire must never do.
 */
function testBlocks(file: string): TestBlock[] {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
  const starts: number[] = []
  lines.forEach((l, i) => {
    if (TEST_START.test(l)) starts.push(i)
  })
  return starts.map((start, k) => {
    let end = k + 1 < starts.length ? starts[k + 1] : lines.length
    for (let i = start + 1; i < end; i++) {
      if (DESCRIBE_START.test(lines[i])) { end = i; break }
    }
    const raw = lines[start]
    const title = /['"`](.*?)['"`]/.exec(raw)?.[1] ?? raw.trim().slice(0, 60)
    return { file, line: start + 1, title, body: lines.slice(start, end).join('\n') }
  })
}

/**
 * Names of functions defined in this file whose own body calls `expect(`.
 *
 * Without this the scan reports false violations on tests that assert through a named helper:
 * `assertRedaction(rows)` in intel-anonymous-author-redaction.test.ts and `sameCamera(got, want)`
 * in roadmap-lens-camera.test.ts both assert, and both would look empty to a bare `expect(` grep.
 * Extracting a well-named helper is good practice, so the rule must not punish it.
 */
function assertionHelpers(src: string): Set<string> {
  const names = new Set<string>()
  const decl = /(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>)/g
  let m: RegExpExecArray | null
  const positions: Array<[string, number]> = []
  while ((m = decl.exec(src)) !== null) positions.push([m[1] ?? m[2], m.index])
  positions.forEach(([name, at], i) => {
    const end = i + 1 < positions.length ? positions[i + 1][1] : src.length
    if (/\bexpect[(.]/.test(src.slice(at, end))) names.add(name)
  })
  return names
}

const files = ROOTS.flatMap(testFiles).sort()
const SELF = 'src/__tests__/test-suite-standards.test.ts'

describe('the test suite meets its own standards', () => {
  it('finds the test files (guards against the enumeration silently breaking)', () => {
    // Without this, a bad glob would make every rule below pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(500)
  })

  it('no test is focused with .only — it would silently disable every other test', () => {
    const offenders = files
      .filter((f) => !f.endsWith('test-suite-standards.test.ts'))
      .flatMap((f) => {
        const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
        return lines
          .map((l, i) => (/\b(?:it|test|describe)\.only\b/.test(l) ? `${f}:${i + 1}` : null))
          .filter((x): x is string => x !== null)
      })
    expect(offenders, `.only left in: ${offenders.join(', ')}`).toEqual([])
  })

  it('no test uses a fixed sleep for synchronization', () => {
    // A guessed delay races under CI load and wastes wall-clock when it is over-generous.
    // Use vi.waitFor / waitFor / findBy* to poll the condition, or await the real promise.
    const offenders = files
      .filter((f) => f !== SELF)
      .flatMap((f) => {
        const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
        return lines
          .map((l, i) =>
            /new Promise\([^)]*\)\s*=>\s*setTimeout|setTimeout\(\s*(?:r|res|resolve|done)\s*,\s*[1-9]/.test(l)
              ? `${f}:${i + 1}`
              : null,
          )
          .filter((x): x is string => x !== null)
      })
    expect(
      offenders,
      `fixed sleep used as synchronization in: ${offenders.join(', ')}. ` +
        `Poll the observable condition with vi.waitFor/waitFor instead.`,
    ).toEqual([])
  })

  it('no test asserts via a snapshot', () => {
    // A snapshot diff gets approved without being understood; assert the semantics instead.
    const offenders = files
      .filter((f) => f !== SELF)
      .filter((f) => /toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot/.test(stripComments(readFileSync(f, 'utf8'))))
    expect(offenders, `snapshot assertions in: ${offenders.join(', ')}`).toEqual([])
  })

  it('every test asserts something', () => {
    /* The rule that catches the worst failure: a test that "passes by virtue of not crashing"
       also passes when the function it covers is deleted. Counts a call to a same-file helper
       whose body asserts, so extracting `assertRedaction(rows)` stays legal. */
    const offenders: string[] = []
    for (const f of files) {
      if (f === SELF) continue
      const src = stripComments(readFileSync(f, 'utf8'))
      const helpers = assertionHelpers(src)
      const helperCall = helpers.size
        ? new RegExp(`\\b(?:${[...helpers].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\(`)
        : null
      for (const t of testBlocks(f)) {
        // A Playwright spec whose body is only `test.skip(...)` is a guarded skip, not a test.
        if (/^\s*(?:test|it)\.skip\s*\(/.test(t.body.split('\n')[0])) continue
        if (/\bexpect[(.]/.test(t.body)) continue
        if (helperCall && helperCall.test(t.body)) continue
        offenders.push(`${t.file}:${t.line} "${t.title}"`)
      }
    }
    expect(
      offenders,
      `these tests assert nothing, so they pass even if the code under test is deleted:\n  ` +
        offenders.join('\n  '),
    ).toEqual([])
  })

  it('no test skips itself from inside a catch block', () => {
    /* The worst shape found in the 2026-09-15 audit, in live-classroom-m1-sync.spec.ts: a whole
       test body wrapped in try/catch whose catch called `test.skip(true, 'PDF fixture not
       available')`. Every assertion inside became unfailable — a broken screen, a renamed
       string and a 500 all reported as "skipped". If a precondition is genuinely optional,
       check it directly (`describe.skipIf(!hasFixture)`); do not catch the failure. */
    const offenders: string[] = []
    for (const f of files) {
      if (f === SELF) continue
      const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
      lines.forEach((l, i) => {
        if (!/\bcatch\b/.test(l)) return
        const window = lines.slice(i, i + 6).join('\n')
        if (/\b(?:test|it)\.skip\s*\(/.test(window)) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(
      offenders,
      `a catch block skips the test in: ${offenders.join(', ')}. ` +
        `This makes every assertion in the try unfailable. Check the precondition directly instead.`,
    ).toEqual([])
  })

  it('every skipped test states why', () => {
    /* A skip with no reason is never revisited. Playwright's `test.skip(cond, 'reason')` carries
       its own; a bare `it.skip(` needs a comment on the line above. */
    const offenders: string[] = []
    for (const f of files) {
      if (f === SELF) continue
      const raw = readFileSync(f, 'utf8').split('\n')
      const stripped = stripComments(readFileSync(f, 'utf8')).split('\n')
      stripped.forEach((l, i) => {
        if (!/\b(?:it|test|describe)\.(?:skip|todo)\b/.test(l)) return
        // The call may wrap across lines, so look at the whole call, not just its first line.
        const call = stripped.slice(i, i + 4).join('\n')
        const hasInlineReason = /,[\s\S]{0,120}?['"`]/.test(call)
        const prev = (raw[i - 1] ?? '').trim()
        const hasComment = prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*')
        if (!hasInlineReason && !hasComment) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(
      offenders,
      `skipped with no stated reason: ${offenders.join(', ')}. ` +
        `Add a reason argument or a comment above it, or delete the test.`,
    ).toEqual([])
  })
})
