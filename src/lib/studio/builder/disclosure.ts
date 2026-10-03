/**
 * The disclosure guard (Step 9): plugin text may not copy course material students can't
 * see yet. Pure; the caller passes the current text of every source the project's builds
 * read, as studio_course_sources returns it, with each one's disclosure class now.
 *
 * What it catches: accidental verbatim copying, including a sentence split across JSX text
 * and string literals, because each view becomes one word stream before shingling. What it
 * doesn't: paraphrase, or a model told to evade it (characters built at run time, words
 * changed every few). The version review that names unopened sources before students get a
 * version is the control that decides; this keeps honest builds from leaking by accident.
 *
 * A source that has opened since is `released` and never counts. Every other class does:
 * scheduled, and withheld (hidden or unpublished after the model saw it).
 */
import ts from 'typescript'
import type { StudioManifestV2 } from '../manifest'
import { PLUGIN_PATHS, type PluginPath } from './paths'

/** A source the builder read, with its current text and disclosure class. */
export interface GuardSource {
  key: string
  label: string
  disclosure: 'released' | 'scheduled' | 'withheld'
  opensAt: string | null
  text: string
}

export interface GuardHit {
  key: string
  label: string
  file: PluginPath | 'manifest'
}

export interface GuardResult {
  /** Copies that fail the draft. */
  copies: GuardHit[]
  /** One shared run of words: below the failure line, reported to the professor as a close match. */
  near: GuardHit[]
}

/** Words in a shingle, and the shared shingles that fail a draft (a run of 6 words). */
export const SHINGLE_WORDS = 5
export const SHINGLES_TO_FAIL = 2
/** A source shorter than this many words is matched whole; under 4 words it's too generic to judge. */
const SHORT_UNIT_WORDS = 10
const MIN_WHOLE_WORDS = 4

/** NFKC, case-folded, punctuation removed: the words two texts are compared by. */
export function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
}

/** Every string literal, template text and JSX text in one view, in source order, as words. */
export function viewWords(path: PluginPath, source: string): string[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const out: string[] = []
  // Iterative, in source order: children are pushed in reverse.
  const stack: ts.Node[] = [sf]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) continue
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push(...words(node.text))
    } else if (ts.isJsxText(node)) {
      out.push(...words(node.text))
    }
    const children = node.getChildren(sf)
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return out
}

/** The manifest's own words: name, description, purpose summary and skill slot labels. */
export function manifestWords(manifest: StudioManifestV2 | null): string[] {
  if (!manifest) return []
  return words([manifest.name, manifest.description, manifest.purpose.summary, ...manifest.skillSlots.map((s) => s.label)].join(' '))
}

function shingleSet(list: readonly string[]): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i + SHINGLE_WORDS <= list.length; i++) set.add(list.slice(i, i + SHINGLE_WORDS).join(' '))
  return set
}

/** Whether `needle` appears as a run of whole words in `hay`. */
function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  return ` ${hay.join(' ')} `.includes(` ${needle.join(' ')} `)
}

/** The guard over one working copy: each view and the manifest against every unopened source. */
export function findCopies(
  work: { manifest: StudioManifestV2 | null; files: Partial<Record<PluginPath, string>> },
  sources: readonly GuardSource[],
): GuardResult {
  const streams: { file: PluginPath | 'manifest'; words: string[] }[] = [
    ...PLUGIN_PATHS.flatMap((p) => (typeof work.files[p] === 'string' ? [{ file: p, words: viewWords(p, work.files[p]!) }] : [])),
    { file: 'manifest' as const, words: manifestWords(work.manifest) },
  ]
  const sets = streams.map((s) => ({ ...s, set: shingleSet(s.words) }))
  const copies: GuardHit[] = []
  const near: GuardHit[] = []
  for (const source of sources) {
    if (source.disclosure === 'released') continue
    const w = words(source.text)
    if (w.length < SHORT_UNIT_WORDS) {
      if (w.length < MIN_WHOLE_WORDS) continue
      const hit = streams.find((s) => containsRun(s.words, w))
      if (hit) copies.push({ key: source.key, label: source.label, file: hit.file })
      continue
    }
    const own = shingleSet(w)
    let best: { file: PluginPath | 'manifest'; shared: number } | null = null
    for (const s of sets) {
      let shared = 0
      for (const sh of own) if (s.set.has(sh)) shared += 1
      if (shared > 0 && (!best || shared > best.shared)) best = { file: s.file, shared }
    }
    if (!best) continue
    if (best.shared >= SHINGLES_TO_FAIL) copies.push({ key: source.key, label: source.label, file: best.file })
    else near.push({ key: source.key, label: source.label, file: best.file })
  }
  return { copies, near }
}
