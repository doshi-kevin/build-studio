/**
 * Project memory, the pure part: what a saved decision may say, what counts as the
 * professor's own words, and which decisions go into a turn's prompt. No database, no
 * model. The database functions (supabase/migrations/20261002210000_studio_project_memory.sql)
 * enforce the same rules again; this file makes the harness refuse early with a hint.
 *
 * Memory is data in the prompt, never authority. The authority order, highest first:
 * platform rules, tools and their refusals, the tool's current files and manifest, the
 * professor's current request, saved decisions, earlier builds and findings. A saved
 * decision never outranks the request in front of the model.
 */
import {
  STUDIO_MEMORY_CONSTRAINTS_MAX,
  STUDIO_MEMORY_CONTEXT_MAX_BYTES,
  STUDIO_MEMORY_CONTEXT_MAX_ITEMS,
  STUDIO_MEMORY_EVIDENCE_MAX_CHARS,
  STUDIO_MEMORY_EVIDENCE_MIN_CHARS,
  STUDIO_MEMORY_PREFERENCES_MAX,
  STUDIO_MEMORY_STATEMENT_MAX_CHARS,
} from '../limits'
import { characterProblem, utf8Bytes } from './paths'

export const MEMORY_TOPICS = ['student_ui', 'professor_ui', 'content_policy', 'accessibility', 'data_collection', 'terminology', 'other'] as const
export type MemoryTopic = (typeof MEMORY_TOPICS)[number]

export const MEMORY_KINDS = ['constraint', 'preference'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** What a professor sees for each topic. Fixed copy. */
export const TOPIC_LABEL: Record<MemoryTopic, string> = {
  student_ui: 'Student view',
  professor_ui: 'Professor view',
  content_policy: 'Content and AI rules',
  accessibility: 'Accessibility',
  data_collection: 'What the tool collects',
  terminology: 'Wording',
  other: 'Other',
}

/** What a professor sees: when Athena uses the decision, not what the system calls it. */
export const KIND_LABEL: Record<MemoryKind, string> = { constraint: 'Every build', preference: 'When relevant' }

/** An active saved decision, as the context builder and the panel read it. */
export interface ProjectMemory {
  id: string
  topic: MemoryTopic
  kind: MemoryKind
  statement: string
  createdAt: string
  updatedAt: string
}

/** A saved decision shown to the model under a short label. The model never sees an id. */
export interface ShownMemory extends ProjectMemory {
  alias: string
}

// ── What a statement may say ─────────────────────────────────────────

// Text that talks to the builder about how it works, or tries to change its rules. A
// saved decision describes the tool, so none of this belongs in one. A false positive
// only asks the professor to reword; it never loses anything.
const META: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass|circumvent|disable|skip|turn off|switch off|remove)\b[^.]{0,60}\b(instructions?|rules?|polic(?:y|ies)|checks?|validators?|validation|approvals?|safety|guardrails?|restrictions?|limits?|filters?)\b/i,
  /\b(system|developer|hidden)\s+(prompt|message|instructions?)\b/i,
  /\b(previous|prior|above|earlier|future)\s+(instructions?|rules?|messages?|sessions?)\b/i,
  /\b(read_file|get_kit_reference|write_file|edit_file|propose_manifest_change|run_checks|submit_plan|ask_professor|propose_memory)\b/i,
  /\b(validators?|entitlements?|kill switch|service[_ ]role|api[_ ]key)\b/i,
  // Publication and approval directives: only the professor publishes, installs or activates a tool.
  /\b(publish|install|activate|deploy)\b[^.]{0,30}\b(this|the|my|every|each)\s+(tool|plugin|version|draft|build)s?\b/i,
  /\b(auto(?:matically)?[- ]?(?:publish|install|activate)|without\s+(?:asking|approval|review|confirmation|the professor))\b/i,
]

export type StatementProblem = 'length' | 'characters' | 'format' | 'meta'

/** Why a statement can't be saved, or null. Applies to the model's proposals and to the professor's own typing. */
export function statementProblem(text: string): StatementProblem | null {
  if (text.length < 1 || text.length > STUDIO_MEMORY_STATEMENT_MAX_CHARS) return 'length'
  if (characterProblem(text)) return 'characters'
  if (text !== text.trim() || /[\r\n\t<>]/.test(text)) return 'format'
  if (META.some((p) => p.test(text))) return 'meta'
  return null
}

// ── The professor's own words ────────────────────────────────────────

/** The only text that may support a proposal: this run's request and the professor's answers in it. */
export function professorTextsOf(run: { request: string | null; questions: { answer: string | null }[] }): string[] {
  return [run.request ?? '', ...run.questions.flatMap((q) => (q.answer ? [q.answer] : []))].filter((t) => t.length > 0)
}

export type EvidenceProblem = 'format' | 'not_professor_words'

/**
 * Whether the quote supports the sentence: they share at least one content word. Without
 * this, any four characters from the request would make a sentence the model chose look
 * like the professor said it.
 */
export function supports(statement: string, evidence: string): boolean {
  const said = new Set(tokens(evidence))
  return tokens(statement).some((w) => said.has(w))
}

/** Evidence is an exact quote. Anything the professor did not type in this run is not evidence. */
export function evidenceProblem(evidence: string, professorTexts: string[]): EvidenceProblem | null {
  if (evidence !== evidence.trim()) return 'format'
  if (evidence.length < STUDIO_MEMORY_EVIDENCE_MIN_CHARS || evidence.length > STUDIO_MEMORY_EVIDENCE_MAX_CHARS) return 'format'
  return professorTexts.some((t) => t.includes(evidence)) ? null : 'not_professor_words'
}

// ── Which decisions go into a turn ───────────────────────────────────

/** Labels are stable for a project: oldest decision first, m1, m2, and so on. */
export function aliased(all: ProjectMemory[]): ShownMemory[] {
  return [...all]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((m, i) => ({ ...m, alias: `m${i + 1}` }))
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'make', 'add', 'change', 'want', 'need', 'please', 'tool', 'use', 'can', 'should', 'would',
  'from', 'into', 'more', 'less', 'also', 'are', 'was', 'not', 'its', 'any', 'all', 'have', 'has', 'will', 'but', 'you', 'your', 'they',
  'them', 'then', 'when', 'where', 'what', 'how', 'out', 'new', 'now', 'let', 'get', 'put', 'set', 'show', 'keep', 'like', 'just',
])

const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t))

// Words in a request that point at a topic. Prefix match from four letters, exact below.
const TOPIC_WORDS: Record<MemoryTopic, string[]> = {
  student_ui: ['student', 'button', 'screen', 'layout', 'simple', 'ui', 'interface', 'font', 'size', 'larger', 'bigger', 'smaller', 'color', 'colour', 'design', 'look', 'mobile', 'phone', 'label', 'card', 'spacing', 'text', 'heading', 'style', 'theme', 'dark'],
  professor_ui: ['professor', 'instructor', 'staff', 'dashboard', 'report', 'summary', 'overview', 'table', 'grading'],
  content_policy: ['ai', 'anonym', 'identity', 'private', 'privacy', 'hide', 'hidden', 'grade', 'score', 'answer', 'cheat', 'plagiar', 'share', 'visible', 'name'],
  accessibility: ['access', 'contrast', 'reader', 'keyboard', 'font', 'larger', 'bigger', 'size', 'button', 'color', 'colour', 'readab', 'read', 'tap', 'touch', 'motion', 'caption'],
  data_collection: ['collect', 'store', 'save', 'record', 'data', 'track', 'submit', 'response', 'privacy', 'log', 'analytics'],
  terminology: ['term', 'word', 'wording', 'call', 'name', 'label', 'say', 'language', 'tone', 'phrase', 'rename', 'title', 'text', 'vocab'],
  other: [],
}

const hits = (words: Set<string>, keys: string[]) => keys.filter((k) => [...words].some((w) => (k.length < 4 ? w === k : w.startsWith(k)))).length

export interface MemorySelectionInput {
  /** The professor's request and answers: the only text the relevance score reads. */
  text: string
  /** Views this build may touch. A preference about a view is relevant whenever the build may change that view. */
  views: { student: boolean; professor: boolean }
}

export interface MemorySelection {
  constraints: ShownMemory[]
  preferences: ShownMemory[]
}

export const memoryLine = (m: ShownMemory) => `${m.alias} ${m.kind} (${m.topic}): ${m.statement}`
const linesBytes = (items: ShownMemory[]) => utf8Bytes(items.map(memoryLine).join('\n'))

/**
 * Tier A: every active constraint, oldest first, up to 6. Tier B: preferences that match
 * the request or the views being built, best first, up to 4. Together at most 8 and 2 KiB;
 * when that is too much, preferences go before constraints. Same inputs, same selection.
 */
export function selectMemories(all: ProjectMemory[], input: MemorySelectionInput): MemorySelection {
  const list = aliased(all)
  const constraints = list.filter((m) => m.kind === 'constraint').slice(0, STUDIO_MEMORY_CONSTRAINTS_MAX)
  const words = new Set(tokens(input.text))
  const scored = list
    .filter((m) => m.kind === 'preference')
    .map((m) => {
      const own = new Set(tokens(m.statement))
      const overlap = [...own].filter((w) => words.has(w)).length
      const view = (m.topic === 'student_ui' && input.views.student) || (m.topic === 'professor_ui' && input.views.professor) ? 1 : 0
      return { m, score: 2 * hits(words, TOPIC_WORDS[m.topic]) + overlap + view }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt) || a.m.alias.localeCompare(b.m.alias, 'en', { numeric: true }))
  let preferences = scored.map((s) => s.m).slice(0, Math.min(STUDIO_MEMORY_PREFERENCES_MAX, STUDIO_MEMORY_CONTEXT_MAX_ITEMS - constraints.length))
  let kept = constraints
  while (preferences.length > 0 && linesBytes([...kept, ...preferences]) > STUDIO_MEMORY_CONTEXT_MAX_BYTES) preferences = preferences.slice(0, -1)
  // Constraints alone over the byte cap (long multi-byte text): the newest go first.
  while (kept.length > 0 && linesBytes(kept) > STUDIO_MEMORY_CONTEXT_MAX_BYTES) kept = kept.slice(0, -1)
  return { constraints: kept, preferences }
}
