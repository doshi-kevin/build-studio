/**
 * `leave_study_artifact` — Athena's one `create` tool (design doc §15).
 *
 * Mid-conversation, the model can generate an interactive study artifact —
 * flashcards, a practice set, a study checklist (the kind registry in
 * `@/lib/athena/artifact-kinds` is the single extension point) — and leave it
 * on the student's roadmap as a margin note pinned to a module. The content
 * rides in the tool input (model-authored by nature); every identifier comes
 * from the verified ctx, and the module anchor arrives as a HUMAN LABEL
 * ("Week 6", a module title) resolved server-side against this section's own
 * published modules — a selector inside an already-authorized scope, never a
 * capability.
 *
 * Exposed only in copilot drive mode: leaving things on the roadmap is Athena
 * driving the app, which is exactly the axis that mode governs.
 */

import { z } from 'zod'
import { openModuleFilter } from '@/lib/modules/unlock'
import { MIN_LABEL_MATCH_LEN, labelWordSubset, normalizeLabel } from '@/lib/roadmap/annotation-target'
import { resolveQuestionCitation, type QuizSource } from '@/lib/quiz/source-citation'
import { athenaNodeKey, isArtifactKind, ARTIFACT_KIND_META, type ArtifactKind, type ArtifactPayload, type Cite } from '@/lib/athena/artifact-kinds'
import { saveArtifact } from './artifact-store'
import { defineStudentTool, type AthenaStudentCtx } from './contract'

/** A page retrieved this turn, as the route hands it over (see the ctx type). */
type CitablePage = NonNullable<AthenaStudentCtx['citablePages']>[number]

/** The page a generated item is drawn from. Named `material`/`page` (not an id)
 *  so it survives the create-tool's no-identifier-fields guard; it is checked
 *  against the turn's `citablePages` server-side, never trusted as authorization. */
const CITE = z.object({
  material: z.string().min(1).max(200)
    .describe('The lecture/document title EXACTLY as it appears in the [Title, p.N] marker of the page this is drawn from.'),
  page: z.number().int().min(1).describe('That page number.'),
})

const INPUT = z.object({
  kind: z.enum(['flashcards', 'practice', 'checklist', 'study_guide']),
  title: z.string().min(1).max(120)
    .describe('Short student-facing name for the artifact, e.g. "Backprop Through Time".'),
  module: z.string().min(1).max(200)
    .describe('Which module it belongs to, as named in the course context — the module title or "Week N". Resolved server-side; if it does not match, the tool returns the valid module names to pick from.'),
  cards: z.array(z.object({
    front: z.string().min(1).max(300),
    back: z.string().min(1).max(600),
    cite: CITE.describe('The course page this card is drawn from. Required — a card that does not cite a page in front of you right now is dropped.'),
  })).min(2).max(20).optional()
    .describe('flashcards only: the deck. front = term/question, back = the explanation.'),
  questions: z.array(z.object({
    prompt: z.string().min(1).max(500),
    options: z.array(z.object({
      text: z.string().min(1).max(300),
      correct: z.boolean().optional(),
    })).min(2).max(6),
    explanation: z.string().max(600).optional(),
    cite: CITE.describe('The course page this question is drawn from. Required.'),
  })).min(1).max(10).optional()
    .describe('practice only: multiple-choice questions. Mark EXACTLY ONE option per question with correct: true.'),
  steps: z.array(z.object({
    label: z.string().min(1).max(300),
    minutes: z.number().int().min(1).max(600).optional(),
    cite: CITE.optional().describe('Optional: the page a review step points at, if it names one.'),
  })).min(2).max(12).optional()
    .describe('checklist only: ordered study steps the student ticks off, with a realistic minutes estimate each. Steps are study ACTIONS, so a citation is optional.'),
  sections: z.array(z.object({
    heading: z.string().min(1).max(120),
    points: z.array(z.object({
      text: z.string().min(1).max(500),
      cite: CITE.describe('The course page this point is drawn from. Required.'),
    })).min(1).max(8),
  })).min(1).max(8).optional()
    .describe('study_guide only: ordered sections, each a heading and a few cited points summarizing that part of the material.'),
})

type Input = z.infer<typeof INPUT>

/** The pages retrieved this turn, in the QuizSource shape the shared attribution
 *  engine consumes — so an artifact attributes a page the SAME way an AI-generated
 *  quiz question does (`@/lib/quiz/source-citation`), rather than a second bespoke
 *  matcher. Grouped by title, since one title = one source document. */
function buildSources(pages: readonly CitablePage[]): QuizSource[] {
  const byTitle = new Map<string, { title: string; moduleItemId?: string; pages: { page: number; text: string }[] }>()
  for (const p of pages) {
    const key = normalizeLabel(p.material)
    const src = byTitle.get(key) ?? { title: p.material, moduleItemId: p.moduleItemId, pages: [] }
    src.pages.push({ page: p.page, text: p.text ?? '' })
    byTitle.set(key, src)
  }
  return [...byTitle.values()].map((s) => ({
    title: s.title,
    pageCount: s.pages.reduce((m, pg) => Math.max(m, pg.page), 0),
    ref: { kind: 'module_item' as const, moduleItemId: s.moduleItemId ?? '' },
    pages: s.pages,
  }))
}

/** Trust the model's own cite only when it names a page we ACTUALLY retrieved —
 *  the retrieved set is a subset of the document, so `resolveSourceCitation`'s
 *  page-in-range check isn't enough on its own. */
function hintNamesRetrievedPage(cite: Cite | undefined, sources: QuizSource[]): boolean {
  if (!cite) return false
  const want = normalizeLabel(cite.material)
  return sources.some(
    (s) =>
      (normalizeLabel(s.title).includes(want) || want.includes(normalizeLabel(s.title))) &&
      (s.pages ?? []).some((p) => p.page === cite.page),
  )
}

/**
 * Attribute one generated item to a real retrieved page. Keep the model's cite
 * when it names a page we have; otherwise fall back to the deterministic
 * content-overlap match (`resolveQuestionCitation` → `attributeByContent`, the
 * exact engine quiz generation uses), so a card the model mis-cited is assigned
 * the right page instead of being thrown away. Null only when nothing overlaps —
 * then the item genuinely isn't in front of us and is dropped.
 */
function attribute(text: string, modelCite: Cite | undefined, sources: QuizSource[]): Cite | null {
  const trusted = hintNamesRetrievedPage(modelCite, sources) ? modelCite : undefined
  const citation = resolveQuestionCitation(trusted?.material, trusted?.page, text, sources)
  return citation ? { material: citation.title, page: citation.page } : null
}

/** The correction handed back when too little of an artifact could be attributed
 *  to a page — tells the model to rebuild from the pages actually in context. */
const groundingProblem = (what: string) =>
  `too few ${what}s could be matched to a course page in your context — nothing was saved. Rebuild from the [Title, p.N] pages in front of you and draw each ${what} from one; don't invent a page.`

/** The kind's content, validated beyond shape (which zod already did) AND
 *  grounded: every fact-bearing item is attributed to a retrieved page (`sources`)
 *  and re-stamped with that page; an item that matches none is dropped (design doc
 *  §15.4). Returns the payload to store, or a correction the model can act on. */
function payloadFor(input: Input, sources: QuizSource[]): { payload?: object; problem?: string } {
  switch (input.kind) {
    case 'flashcards': {
      if (!input.cards?.length) return { problem: 'kind "flashcards" needs the `cards` array.' }
      const cards = input.cards
        .map((c) => {
          const cite = attribute(`${c.front}\n${c.back}`, c.cite, sources)
          return cite ? { ...c, cite } : null
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
      if (cards.length < 2) return { problem: groundingProblem('flashcard') }
      return { payload: { cards } }
    }
    case 'practice': {
      if (!input.questions?.length) return { problem: 'kind "practice" needs the `questions` array.' }
      const bad = input.questions.findIndex((q) => q.options.filter((o) => o.correct).length !== 1)
      if (bad >= 0) return { problem: `question ${bad + 1} must mark exactly one option correct: true.` }
      const questions = input.questions
        .map((q) => {
          const cite = attribute(`${q.prompt}\n${q.options.map((o) => o.text).join('\n')}`, q.cite, sources)
          return cite ? { ...q, cite } : null
        })
        .filter((q): q is NonNullable<typeof q> => q !== null)
      if (questions.length < 1) return { problem: groundingProblem('question') }
      return { payload: { questions } }
    }
    case 'checklist':
      // Steps are study actions, not page facts — no attribution gate.
      if (!input.steps?.length) return { problem: 'kind "checklist" needs the `steps` array.' }
      return { payload: { steps: input.steps } }
    case 'study_guide': {
      if (!input.sections?.length) return { problem: 'kind "study_guide" needs the `sections` array.' }
      const sections = input.sections
        .map((s) => ({
          heading: s.heading,
          points: s.points
            .map((p) => {
              const cite = attribute(p.text, p.cite, sources)
              return cite ? { ...p, cite } : null
            })
            .filter((p): p is NonNullable<typeof p> => p !== null),
        }))
        .filter((s) => s.points.length > 0)
      if (sections.length < 1) return { problem: groundingProblem('point') }
      return { payload: { sections } }
    }
  }
}

/** Resolve a spoken module label against this section's published modules:
 *  exact title → "week N" → guarded word-overlap paraphrase, in that order.
 *  The normalisation and word-overlap rules are the shared spoken-label
 *  vocabulary in `annotation-target.ts` — the knowledge map matches concept
 *  titles to roadmap nodes with the same ones. */
function resolveModule(
  label: string,
  modules: { id: string; title: string; week_number: number | null }[],
): { id: string; title: string } | null {
  const wanted = normalizeLabel(label)
  const exact = modules.find((m) => normalizeLabel(m.title) === wanted)
  if (exact) return exact
  const week = /(?:week|module)\s*(\d{1,2})/.exec(wanted)
  if (week) {
    const byWeek = modules.find((m) => m.week_number === Number(week[1]))
    if (byWeek) return byWeek
  }
  // Paraphrase fallback, guarded: only for labels long enough to mean something,
  // matched word-for-word (not a bare `includes`), and only when they name ONE
  // module. An ambiguous label is dropped so the tool asks the model to pick from
  // the real names rather than silently anchoring to the first row.
  if (wanted.length >= MIN_LABEL_MATCH_LEN) {
    const partials = modules.filter((m) => {
      const title = normalizeLabel(m.title)
      if (title.length < MIN_LABEL_MATCH_LEN) return false
      return labelWordSubset(wanted, title) || labelWordSubset(title, wanted)
    })
    if (partials.length === 1) return partials[0]
  }
  return null
}

type Result =
  | { created: true; kind: ArtifactKind; title: string; module: string; summary: string }
  | { created: false; reason: string; modules?: string[] }

export const leaveStudyArtifact = defineStudentTool({
  name: 'leave_study_artifact',
  kind: 'create',
  label: 'A study artifact for your roadmap',
  description:
    'Create an interactive study artifact — flashcards, a short practice set (multiple choice), a study checklist, or a study guide — and pin it to a module on THIS student\'s course roadmap, where they can work through it later. Call it when the student asks for flashcards, practice questions, a study plan, a study guide, or agrees when you offer one; also offer it after explaining a hard concept at length. Ground every flashcard, practice question and study-guide point in the course pages in your context and CITE the [Title, p.N] page each is drawn from — items you can\'t cite are dropped, and if you have no course pages in context you can\'t make one. The artifact is private to this student. After it is created, tell the student where it landed; the app opens it for them.',
  input: INPUT,
  describe: (r: Result) => (r.created ? `${r.summary} → ${r.module}` : r.reason),
  run: async (ctx: AthenaStudentCtx, input: Input): Promise<Result> => {
    if (!isArtifactKind(input.kind)) return { created: false, reason: 'unknown artifact kind' }

    // Cite-and-check grounding (§15.4): a fact-bearing artifact must be built from
    // pages retrieved THIS turn. With none in context there is nothing to attribute
    // to, so decline rather than ship an ungrounded study aid (the G1/G2 honesty
    // rule). A checklist is study actions, not page facts, so it's exempt.
    const sources = buildSources(ctx.citablePages ?? [])
    if (input.kind !== 'checklist' && sources.length === 0) {
      return {
        created: false,
        reason:
          "I can only build study material from this course's pages, and I don't have any relevant ones in front of me here — ask me about the specific material first, then I can make it.",
      }
    }
    const { payload, problem } = payloadFor(input, sources)
    if (!payload) return { created: false, reason: problem ?? 'missing content' }

    // Anchor: this section's published AND already-open modules only — the label
    // can't reach outside the scope the enrollment check already authorized, and
    // a note must never land on a not-yet-open week the roadmap itself won't show
    // (openModuleFilter, the same gate every student-facing reader applies).
    const { data: modules } = await ctx.adminDb
      .from('modules')
      .select('id, title, week_number')
      .eq('section_id', ctx.sectionId)
      .eq('is_published', true)
      .or(openModuleFilter())
      .is('system_kind', null)
      .order('position', { ascending: true })
      .limit(100)
    const target = resolveModule(input.module, modules ?? [])
    if (!target) {
      return {
        created: false,
        reason: `no module matches "${input.module}"`,
        modules: (modules ?? []).map((m: { title: string }) => m.title),
      }
    }

    // The cap, the ctx-only tenancy columns and the audit event are the shared
    // write path (`artifact-store.ts`) — the same one the knowledge map uses.
    const saved = await saveArtifact(ctx, {
      moduleId: target.id,
      kind: input.kind,
      title: input.title,
      payload,
    })
    if ('problem' in saved) return { created: false, reason: saved.problem }

    // Freshness is the CLIENT's job here, not `revalidatePath`. This runs inside
    // the streaming tool call, where Next.js silently drops `revalidatePath`; and
    // the student is usually already on the roadmap (the dock is ambient), so the
    // `?node=` push is a same-path query change the router serves from its cache
    // without refetching. The shell issues a `router.refresh()` when it takes the
    // drive below, which re-renders the roadmap with this note present.

    // Land the student on it: the roadmap's ?node= deep link opens the note's
    // modal. Server-chosen key, same channel as every other drive.
    ctx.emit({ type: 'goto_node', nodeKey: athenaNodeKey(saved.id), title: input.title })

    return {
      created: true,
      kind: input.kind,
      title: input.title,
      module: target.title,
      summary: ARTIFACT_KIND_META[input.kind].summary(payload as ArtifactPayload),
    }
  },
})
