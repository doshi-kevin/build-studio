/**
 * Project memory, the pure part: what a saved decision may say, what counts as the
 * professor's own words, and which decisions go into a turn's prompt. No database, no
 * model. The database functions (supabase/migrations/20261002210000_studio_project_memory.sql
 * and 20261002230000_studio_memory_slots.sql) enforce the hard rules again: the quote is an
 * exact substring of this run's professor text, the slot belongs to the topic, a replacement
 * is in the right slot. The softer checks here (the quote supports the sentence, the quote
 * doesn't start after a negation) are the harness's alone; the professor's approval of the
 * exact card is the final check.
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

/**
 * The slots of each topic: the independent decisions a topic can hold, one active decision
 * each. Closed lists, so the model can't invent a slot. Every topic has `general`, where
 * decisions made before slots existed live. The database's slot check lists the same pairs
 * (supabase/migrations/20261002230000_studio_memory_slots.sql).
 */
export const MEMORY_SLOTS = {
  student_ui: ['general', 'complexity', 'layout', 'interaction', 'feedback'],
  professor_ui: ['general', 'layout', 'analytics', 'workflow'],
  content_policy: ['general', 'ai_usage', 'anonymity', 'answer_visibility', 'grading', 'tone'],
  accessibility: ['general', 'motion', 'contrast', 'keyboard', 'readability', 'target_size'],
  data_collection: ['general', 'tracking', 'retention', 'identity', 'free_text'],
  terminology: ['general', 'naming', 'reading_level'],
  other: ['general'],
} as const satisfies Record<MemoryTopic, readonly string[]>

export type MemorySlot = (typeof MEMORY_SLOTS)[MemoryTopic][number]

/** Every slot name, for the tool schema. Whether a slot belongs to a topic is checked separately. */
export const MEMORY_SLOT_KEYS = [...new Set(Object.values(MEMORY_SLOTS).flat())] as [MemorySlot, ...MemorySlot[]]

export function isSlotOf(topic: MemoryTopic, slot: string): slot is MemorySlot {
  return (MEMORY_SLOTS[topic] as readonly string[]).includes(slot)
}

/** What a professor sees for each slot. Fixed copy. */
export const SLOT_LABEL: Record<MemoryTopic, Record<string, string>> = {
  student_ui: { general: 'Overall', complexity: 'How simple it is', layout: 'Layout', interaction: 'How students interact', feedback: 'What students see after answering' },
  professor_ui: { general: 'Overall', layout: 'Layout', analytics: 'Results and summaries', workflow: 'Your workflow' },
  content_policy: { general: 'Overall', ai_usage: 'Use of AI', anonymity: 'Anonymity', answer_visibility: 'When answers are shown', grading: 'Grading and scores', tone: 'Tone' },
  accessibility: { general: 'Overall', motion: 'Motion and animation', contrast: 'Contrast and color', keyboard: 'Keyboard use', readability: 'Readability', target_size: 'Button and tap size' },
  data_collection: { general: 'Overall', tracking: 'What is tracked', retention: 'How long data is kept', identity: 'Names and identity', free_text: 'Free-text answers' },
  terminology: { general: 'Overall', naming: 'What things are called', reading_level: 'Reading level' },
  other: { general: 'Other' },
}

/** "Content and AI rules: Use of AI", or just "Other" for the topic with one slot. */
export function categoryLabel(topic: MemoryTopic, slot: string): string {
  if (topic === 'other') return TOPIC_LABEL.other
  return `${TOPIC_LABEL[topic]}: ${SLOT_LABEL[topic][slot] ?? SLOT_LABEL[topic].general}`
}

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
  slot: MemorySlot
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

export type EvidenceProblem = 'format' | 'not_professor_words' | 'after_negation'

/**
 * Whether the quote supports the sentence: they share at least one content word (function
 * words such as "to", "no" or "the" don't count). Without this, any four characters from the
 * request would make a sentence the model chose look like the professor said it.
 */
export function supports(statement: string, evidence: string): boolean {
  const said = new Set(tokens(evidence))
  return tokens(statement).some((w) => said.has(w))
}

// A quote that starts just after one of these, within two words, may say the opposite of
// what the professor meant: "Don't show answers to students" quoted as "answers to students".
const NEGATION_BEFORE = /(?:\bnot|\bcannot|n['’]t|\bnever|\bno|\bwithout|\bnor)\s+(?:[\w'’-]+\s+){0,2}$/i

/** Evidence is an exact quote. Anything the professor did not type in this run is not evidence. */
export function evidenceProblem(evidence: string, professorTexts: string[]): EvidenceProblem | null {
  if (evidence !== evidence.trim()) return 'format'
  if (evidence.length < STUDIO_MEMORY_EVIDENCE_MIN_CHARS || evidence.length > STUDIO_MEMORY_EVIDENCE_MAX_CHARS) return 'format'
  const before: string[] = []
  for (const text of professorTexts) {
    for (let at = text.indexOf(evidence); at !== -1; at = text.indexOf(evidence, at + 1)) before.push(text.slice(Math.max(0, at - 40), at))
  }
  if (before.length === 0) return 'not_professor_words'
  // Every place the quote appears follows a negation: the quote has to include it.
  return before.every((b) => NEGATION_BEFORE.test(b)) ? 'after_negation' : null
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
  // Two-letter function words: never what a decision is about.
  'to', 'of', 'in', 'on', 'it', 'is', 'no', 'or', 'at', 'by', 'an', 'as', 'be', 'do', 'if', 'so', 'up', 'we', 'us', 'me', 'my', 'he', 'am',
])

const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t))

// Words in a request that point at a topic. Prefix match from four letters, exact below.
const TOPIC_WORDS: Record<MemoryTopic, string[]> = {
  student_ui: ['student', 'button', 'screen', 'layout', 'simple', 'ui', 'interface', 'font', 'size', 'larger', 'bigger', 'smaller', 'color', 'colour', 'design', 'look', 'mobile', 'phone', 'label', 'card', 'spacing', 'text', 'heading', 'style', 'theme', 'dark'],
  professor_ui: ['professor', 'instructor', 'staff', 'dashboard', 'report', 'summary', 'overview', 'table', 'grading'],
  content_policy: ['ai', 'anonym', 'identity', 'private', 'privacy', 'hide', 'hidden', 'grade', 'score', 'answer', 'cheat', 'plagiar', 'share', 'visible', 'name'],
  accessibility: ['access', 'contrast', 'reader', 'keyboard', 'font', 'larger', 'bigger', 'size', 'button', 'color', 'colour', 'readab', 'read', 'tap', 'touch', 'motion', 'caption'],
  // Not "submit" or "save": those name buttons far more often than data.
  data_collection: ['collect', 'store', 'record', 'data', 'track', 'response', 'privacy', 'log', 'analytics'],
  terminology: ['term', 'word', 'wording', 'call', 'name', 'label', 'say', 'language', 'tone', 'phrase', 'rename', 'title', 'text', 'vocab'],
  other: [],
}

// Words that point at one slot. A slot names a narrower decision, so a hit counts for more.
const SLOT_WORDS: Record<string, string[]> = {
  'student_ui/complexity': ['simple', 'simpl', 'minimal', 'clutter', 'complex', 'clean', 'busy', 'distract'],
  'student_ui/layout': ['layout', 'column', 'grid', 'order', 'position', 'screen', 'page', 'card'],
  'student_ui/interaction': ['click', 'tap', 'drag', 'swipe', 'flip', 'button', 'select', 'input', 'submit', 'rating', 'slider'],
  'student_ui/feedback': ['feedback', 'result', 'correct', 'explanation', 'hint', 'review'],
  'professor_ui/layout': ['layout', 'column', 'table', 'dashboard'],
  'professor_ui/analytics': ['chart', 'summary', 'analytics', 'report', 'average', 'statistic', 'export', 'result'],
  'professor_ui/workflow': ['workflow', 'step', 'bulk', 'import', 'export', 'approve', 'grade'],
  'content_policy/ai_usage': ['ai', 'llm', 'chatbot', 'gpt', 'generat', 'automat', 'hint', 'machine', 'model'],
  'content_policy/anonymity': ['anonym', 'name', 'identity', 'reviewer', 'author', 'reveal', 'private'],
  'content_policy/answer_visibility': ['answer', 'solution', 'reveal', 'key', 'visible'],
  'content_policy/grading': ['grade', 'score', 'point', 'mark', 'rubric', 'credit'],
  'content_policy/tone': ['tone', 'friendly', 'formal', 'encourag', 'harsh', 'polite'],
  'accessibility/motion': ['motion', 'animat', 'flash', 'transition'],
  'accessibility/contrast': ['contrast', 'color', 'colour', 'dark', 'light', 'theme'],
  'accessibility/keyboard': ['keyboard', 'tab', 'focus', 'shortcut'],
  'accessibility/readability': ['font', 'read', 'text', 'dyslex', 'spacing'],
  'accessibility/target_size': ['button', 'tap', 'target', 'larger', 'bigger', 'touch', 'size'],
  'data_collection/tracking': ['track', 'analytic', 'log', 'time', 'record'],
  'data_collection/retention': ['retain', 'retention', 'delete', 'store', 'expire', 'archive'],
  'data_collection/identity': ['name', 'identity', 'email', 'anonym'],
  'data_collection/free_text': ['free', 'text', 'comment', 'essay', 'open', 'write'],
  'terminology/naming': ['call', 'name', 'rename', 'term', 'label', 'word'],
  'terminology/reading_level': ['reading', 'level', 'jargon', 'plain'],
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

export const memoryLine = (m: ShownMemory) => `${m.alias} ${m.kind} (${m.topic}/${m.slot}): ${m.statement}`
const linesBytes = (items: ShownMemory[]) => utf8Bytes(items.map(memoryLine).join('\n'))

/**
 * How much a request is about a decision: its topic words (2 each), its slot words (3
 * each), words it shares with the decision (1 each), and 1 when the build may touch the
 * decision's view. Deterministic: the same text gives the same score.
 */
export function relevance(m: ProjectMemory, input: MemorySelectionInput): number {
  const words = new Set(tokens(input.text))
  const overlap = [...new Set(tokens(m.statement))].filter((w) => words.has(w)).length
  const view = (m.topic === 'student_ui' && input.views.student) || (m.topic === 'professor_ui' && input.views.professor) ? 1 : 0
  return 2 * hits(words, TOPIC_WORDS[m.topic]) + 3 * hits(words, SLOT_WORDS[`${m.topic}/${m.slot}`] ?? []) + overlap + view
}

type Scored = { m: ShownMemory; score: number }
const byAlias = (a: Scored, b: Scored) => a.m.alias.localeCompare(b.m.alias, 'en', { numeric: true })
// On a tie a constraint keeps its place by age; the preference the professor decided most recently wins.
const constraintOrder = (a: Scored, b: Scored) => b.score - a.score || a.m.createdAt.localeCompare(b.m.createdAt) || byAlias(a, b)
const preferenceOrder = (a: Scored, b: Scored) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt) || byAlias(a, b)

/**
 * Tier A: active constraints, the most relevant first (oldest first on a tie), up to 6. A
 * constraint is sent whatever the request says, as long as there is room. Tier B:
 * preferences the request or the views being built make relevant, best first (the most recently decided first on a tie), up to 4.
 * Together at most 8 and 2 KiB; when that is too much, preferences go before constraints.
 * Same inputs, same selection.
 */
export function selectMemories(all: ProjectMemory[], input: MemorySelectionInput): MemorySelection {
  const list: Scored[] = aliased(all).map((m) => ({ m, score: relevance(m, input) }))
  const constraints = list.filter((s) => s.m.kind === 'constraint').sort(constraintOrder).slice(0, STUDIO_MEMORY_CONSTRAINTS_MAX).map((s) => s.m)
  const scored = list.filter((s) => s.m.kind === 'preference' && s.score > 0).sort(preferenceOrder)
  let preferences = scored.map((s) => s.m).slice(0, Math.min(STUDIO_MEMORY_PREFERENCES_MAX, STUDIO_MEMORY_CONTEXT_MAX_ITEMS - constraints.length))
  let kept = constraints
  while (preferences.length > 0 && linesBytes([...kept, ...preferences]) > STUDIO_MEMORY_CONTEXT_MAX_BYTES) preferences = preferences.slice(0, -1)
  // Constraints alone over the byte cap (long multi-byte text): the least relevant go first.
  while (kept.length > 0 && linesBytes(kept) > STUDIO_MEMORY_CONTEXT_MAX_BYTES) kept = kept.slice(0, -1)
  return { constraints: kept, preferences }
}
