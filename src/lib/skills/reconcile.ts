// Skill reconciliation — merge the section's concepts from every source into
// one canonical `skills` pool, de-duplicated, and auto-derive the activity→skill
// mappings (replacing the manual "Activity mapping" tab).
//
// "Reconcile" in the data sense: combine records from multiple sources into a
// single consistent set, resolving duplicates. The pool (`skills`) is the
// source of truth; sources FEED it and the professor curates it. Feeders:
//   - module upload  → AI extraction (built elsewhere; seeds the pool)
//   - quizzes / exams → the section question bank's per-question `tags`
//   - live quizzes    → titles (also name-matched at recompute time)
//   - assignments     → AI-extracted from each assignment's own text
//                       (extractAssignmentSkills, cached per-assignment), with
//                       module inheritance (assignmentSkillMappings) as fallback.
//
// De-dup is the make-or-break piece: the same concept arriving as "Backprop" /
// "Backpropagation" / "back-propagation" must collapse to ONE pool entry.
// canonicalizeName + matchInPool are that mechanism (an exact-normalised key
// plus a conservative substring fallback; embedding similarity is the upgrade).
//
// Server-only (takes an admin client). Idempotent + additive: it never deletes
// curated skills or existing mappings — re-running only adds what's missing.

import 'server-only'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { extractTopicsFromContent, suggestSkillParent } from '@/lib/ai/llm-client'
import { recordAiUsage } from '@/lib/ai/usage'
import { createAdminClient } from '@/lib/supabase/admin'
import { readAllPages } from '@/lib/supabase/paged-read'
import { checkAiFeature, checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { MAX_SKILL_NAME_LENGTH } from '@/lib/validations/assignment'
import { canonicalizeName, matchInPool } from './canonical'

// Re-exported: several call sites already import it from here.
export { matchInPool }
import { publishSectionSkillsToLibrary, seedSectionSkillsFromLibrary } from './library'

// Re-exported for existing importers; the definition lives in the client-safe
// canonical module so the roadmap node modal can anchor by the same rule.
export { canonicalizeName }

/**
 * Deterministic backstop to the AI assessability classifier: course
 * administration / structure names that aren't things a student can be assessed
 * on. WHOLE-name match on the canonical form (never a substring), so it drops
 * "Course Logistics" / "References" but keeps a real concept that merely contains
 * an admin word (e.g. "Machine Learning Prerequisites"). The prompt is the
 * primary filter; this only catches stragglers it lets through.
 */
const ADMIN_CONCEPTS: ReadonlySet<string> = new Set(
  [
    'Introduction', 'Intro', 'Course Overview', 'Overview', 'Course Logistics', 'Logistics',
    'Agenda', 'Outline', 'Course Outline', 'Syllabus', 'Schedule', 'Course Schedule',
    'Grading Policy', 'Grading Policies', 'Grading', 'Marking Scheme',
    'References', 'Reference', 'Bibliography', 'Further Reading',
    'Acknowledgements', 'Acknowledgments', 'Contact', 'Contact Info', 'Office Hours',
    'About the Instructor', 'About the Course', "What We'll Learn", 'What We Will Learn',
    'Course Outcomes', 'Learning Outcomes', 'Course Objectives', 'Objectives',
    'Q&A', 'Questions', 'Thank You', 'Summary', 'Conclusion', 'Recap', 'Next Time', 'Prerequisites',
  ].map(canonicalizeName),
)

export function isAdministrativeConcept(name: string): boolean {
  return ADMIN_CONCEPTS.has(canonicalizeName(name))
}

/**
 * Deterministic junk detector for names that aren't concepts at all — quiz/slide
 * TITLES, test/QA scaffolding, questions/sentences, structural markers, and
 * repeated-char gibberish. The AI prompt is the primary filter; this catches
 * what feeder text (quiz tags, live-quiz titles, stale caches) drags in verbatim.
 * CONSERVATIVE by design: whole-name canonical matches and anchored patterns, so
 * real concepts survive ("T-test" ≠ "Test", "Question Answering", "Unit Testing",
 * "Backpropagation", "Base64", "Chapter 11 Bankruptcy").
 */
const JUNK_EXACT: ReadonlySet<string> = new Set(
  [
    'test', 'quiz', 'exam', 'sample', 'demo', 'example', 'placeholder', 'untitled',
    'this is a test', 'this is a quiz', 'this is a test quiz', 'test quiz', 'sample quiz',
    'qa check', 'qa test', 'qa verify', 'canary', 'lorem ipsum',
    'todo', 'tbd', 'na', 'none', 'misc', 'other', 'asdf', 'qwerty', 'hello', 'hello world',
  ].map(canonicalizeName),
)

export function isJunkConcept(raw: string): boolean {
  const name = (raw || '').trim()
  const canon = canonicalizeName(name)
  if (!canon) return true // empty / punctuation-only
  if (JUNK_EXACT.has(canon)) return true // whole-name canonical, like ADMIN_CONCEPTS
  if (/^\d+$/.test(canon)) return true // purely numeric
  // Structural marker as the WHOLE name (canonical): slide:3→slide3, "Page 12", "Q4".
  if (/^(slide|page|figure|fig|table|question|q|lecture|module|week|chapter|section|part|unit|lab|hw|homework|quiz|exam|day)\d+$/.test(canon)) return true
  // Title-shaped: a numbered container + separator ("Lecture 4: ...", "Week 3 - ...").
  if (/^(lecture|module|week|chapter|unit|lab|session|class|day|quiz|exam|assignment|homework|slide)\s*#?\d+\s*[:\-–—.]/i.test(name)) return true
  // Question / sentence scaffolding — concepts are noun phrases, not clauses.
  if (name.endsWith('?')) return true
  if (/^(this|these|that|those)\s+(is|are|was|were)\b/i.test(name)) return true
  if (/^(do|does|did|can|could|would|will|should)\s+you\b/i.test(name)) return true
  // QA scaffolding — the separator + verb keeps "Question Answering" / "QA systems".
  if (/^qa[\s-](check|verify|test)/i.test(name)) return true
  // Repeated-char gibberish: 4+ of the same lowercase letter ("Yooooo"); the
  // lowercase-only bound spares acronyms like "AAAA record".
  if (/([a-z])\1{3,}/.test(name)) return true
  return false
}

/** A candidate is not a trackable concept if it's course admin/structure OR junk. */
export function isNonConcept(name: string): boolean {
  return isAdministrativeConcept(name) || isJunkConcept(name)
}

/**
 * Resolve a list of candidate concept names against the section's skill pool.
 * Pure + testable. Used by the assignment AI-skill suggester: an extracted name
 * that matches an existing pool skill becomes a mapping candidate; one that
 * matches nothing is a "new" concept the professor can add. De-duped.
 */
export function resolveSkillNames(
  names: string[],
  pool: Array<{ id: string; canonical: string }>,
): { matchedIds: string[]; newNames: string[] } {
  const matched = new Set<string>()
  const newNames: string[] = []
  const seenNew = new Set<string>()
  for (const raw of names) {
    const name = (raw || '').trim()
    if (!name) continue
    const id = matchInPool(name, pool)
    if (id) { matched.add(id); continue }
    if (isNonConcept(name)) continue // don't surface junk as a "new concept" chip
    const key = canonicalizeName(name)
    if (!key || seenNew.has(key)) continue
    seenNew.add(key)
    newNames.push(name)
  }
  return { matchedIds: [...matched], newNames }
}

/**
 * Assignment → skill mappings by MODULE INHERITANCE: an assignment inherits the
 * skills taught in its linked module's lectures. Pure + testable.
 *
 * This is a heuristic default (assignments carry no skill data of their own) —
 * it only fires when the professor has linked the assignment to a module, and it
 * attributes that module's taught skills to the assignment. Assignments with no
 * module link produce nothing (a per-assignment tagging UI / AI extraction is the
 * eventual precise source — see PR notes).
 */
export function assignmentSkillMappings(
  assignments: Array<{ id: string; module_id: string | null }>,
  topicsByModule: Map<string, string[]>,
  pool: Array<{ id: string; canonical: string }>,
): Array<{ activityId: string; skillId: string }> {
  const out: Array<{ activityId: string; skillId: string }> = []
  for (const a of assignments) {
    if (!a.module_id) continue
    const skillIds = new Set<string>()
    for (const topic of topicsByModule.get(a.module_id) ?? []) {
      const id = matchInPool(topic, pool)
      if (id) skillIds.add(id)
    }
    for (const id of skillIds) out.push({ activityId: a.id, skillId: id })
  }
  return out
}

/** Similarity bench + cap for tagging hand-written rubric questions. Calibrated on
 *  gemini-embedding-2 with a 22-question eval over the section's real module pools
 *  (2026-08-03, union + per-module scenarios): with CONTEXT-ENRICHED candidate texts
 *  (skill name + concept summary), 0.64 tagged every relevant question with the correct
 *  top skill and produced zero off-domain false tags; bare-name embeddings could not do
 *  both at any bench (pun matches like "Node Types" ≈ "neural networks" sit at ~0.69).
 *  Below the bench a question stays untagged; never force a nearest match. */
const SKILL_TAG_SIM_BENCH = 0.64
const SKILL_TAG_SIM_TOP_K = 2

/**
 * Embedding-similarity skill tags for HAND-WRITTEN rubric questions — the fallback tier
 * of the tagging rule: questions that went through a rubric-generation LLM call keep the
 * LLM's tags (even when empty); only questions no LLM ever saw are tagged here.
 * One embed batch over question texts + candidate texts, then per question the top-2
 * candidates by cosine above the bench. Candidates embed as "name. context" when the
 * pool carries a concept summary (see getModuleSkillCandidates) — the context is what
 * separates on-topic hits from lexical pun matches. Best-effort: an embed FAILURE
 * returns null per text (never blocks the save); a successful run that finds nothing
 * (zero candidates, or everything below the bench) returns []. The caller treats BOTH
 * as "no decision" — the question keeps no skills key and a later save retries —
 * because a persisted skills: [] reads as a final tier-1 decision (#553-5).
 */
export async function suggestSkillsBySimilarity(
  texts: string[],
  candidates: Array<{ id: string; name: string; context?: string }>,
  attribution?: { sectionId?: string | null; userId?: string | null },
): Promise<Array<Array<{ id: string; name: string }> | null>> {
  if (texts.length === 0 || candidates.length === 0) return texts.map(() => [])
  // Institution/platform AI kill switch — embeddings are AI spend. null (not [])
  // keeps items untagged so the next save retries once AI is re-enabled; an
  // unattributable call refuses too (fail-closed).
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const verdict = attribution?.sectionId
      ? await checkAiFeatureBySection(adminDb, attribution.sectionId, 'roadmap-skills-ai')
      : { allowed: false as const }
    if (!verdict.allowed) return texts.map(() => null)
  }
  try {
    const { embedTextsBatch } = await import('@/lib/pinecone/embed')
    const { cosineSimilarity } = await import('@/lib/ai/quiz-quality')
    const { vectors: vecs, tokens, estimated } = await embedTextsBatch([...texts, ...candidates.map((c) => (c.context ? `${c.name}. ${c.context}` : c.name))])
    if (attribution?.sectionId) {
      const { EMBEDDING_MODEL } = await import('@/lib/pinecone/config')
      // Fire-and-forget is safe: recordAiUsage catches internally and never rejects.
      void recordAiUsage({
        feature: 'skill_tagging',
        model: EMBEDDING_MODEL,
        sectionId: attribution.sectionId,
        userId: attribution.userId ?? null,
        usage: { inputTokens: tokens },
        ...(estimated ? { metadata: { estimated_tokens: true } } : {}),
      })
    }
    const textVecs = vecs.slice(0, texts.length)
    const candVecs = vecs.slice(texts.length)
    return textVecs.map((tv) =>
      candidates
        .map((c, i) => ({ c, score: cosineSimilarity(tv, candVecs[i]) }))
        .filter(({ score }) => score >= SKILL_TAG_SIM_BENCH)
        .sort((a, b) => b.score - a.score)
        .slice(0, SKILL_TAG_SIM_TOP_K)
        // {id, name} only: `context` is an embedding aid, not part of the stored tag shape.
        .map(({ c }) => ({ id: c.id, name: c.name })),
    )
  } catch (error) {
    logger.warn('suggestSkillsBySimilarity: embed failed, no similarity suggestions', {
      source: 'reconcile.suggestSkillsBySimilarity',
      err: String(error),
    })
    // null (not []): [] would persist as a final "no tags" decision; null keeps the
    // question untagged so the next save retries similarity tagging.
    return texts.map(() => null)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/**
 * Resolve skill NAMES to section skills, creating the genuinely new ones — used when
 * rubric generation mints a skill the tagged modules' pool doesn't cover. Names are
 * junk-filtered, de-duped against the WHOLE section pool (matching an excluded skill
 * drops the name — the professor removed it deliberately; matching a suppressed one
 * tags it, which is the corroboration that later promotes it). New skills insert as
 * tracked top-level mains (source 'ai') so they're immediately visible for curation.
 * Returns resolved {id, name} for every name that survived, keyed by canonical name.
 */
export async function ensureSectionSkills(
  adminDb: AdminDb,
  sectionId: string,
  names: string[],
): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>()
  // skills.name has a 1-120 char DB check while the LLM schema allows 200: drop (never
  // truncate — a 120+ char "name" is a sentence, not a skill, and truncating mints
  // garbled duplicates) over-long names BEFORE the batch insert, where one bad row
  // would reject the whole batch and silently drop every tag for the generation.
  const overlong = names.filter((n) => (n || '').trim().length > MAX_SKILL_NAME_LENGTH)
  if (overlong.length) {
    logger.warn('ensureSectionSkills: dropping over-long skill names', {
      source: 'reconcile.ensureSectionSkills',
      sectionId,
      dropped: overlong.length,
      sample: overlong[0]!.slice(0, 140),
    })
  }
  const cleaned = [...new Set(
    names
      .map((n) => (n || '').trim())
      .filter((n) => n && n.length <= MAX_SKILL_NAME_LENGTH && !isNonConcept(n)),
  )]
  if (!cleaned.length) return out
  try {
    const { data: skillRows } = await adminDb
      .from('skills')
      .select('id, name, parent_id, position, excluded')
      .eq('section_id', sectionId)
    const skills = (skillRows ?? []) as Array<{
      id: string
      name: string
      parent_id: string | null
      position: number
      excluded: boolean
    }>
    const pool = skills.map((s) => ({ id: s.id, canonical: canonicalizeName(s.name) }))
    const byId = new Map(skills.map((s) => [s.id, s]))

    const toCreate: string[] = []
    for (const name of cleaned) {
      const id = matchInPool(name, pool)
      if (id) {
        const existing = byId.get(id)
        if (existing && !existing.excluded) out.set(canonicalizeName(name), { id, name: existing.name })
        continue // excluded match: professor removed it — drop, never resurrect
      }
      toCreate.push(name)
    }
    if (!toCreate.length) return out

    const { data: section } = await adminDb
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .maybeSingle()
    if (!section?.institution_id) return out

    let position = Math.max(-1, ...skills.filter((s) => s.parent_id === null).map((s) => s.position)) + 1
    const rows = toCreate.map((name) => ({
      section_id: sectionId,
      institution_id: section.institution_id,
      parent_id: null,
      name,
      source: 'ai',
      suppressed: false, // activity-linked from birth — already corroborated
      position: position++,
    }))
    const { data: inserted, error } = await adminDb.from('skills').insert(rows).select('id, name')
    if (error) {
      logger.error('ensureSectionSkills: insert failed', error, { sectionId })
      return out
    }
    for (const s of (inserted ?? []) as Array<{ id: string; name: string }>) {
      out.set(canonicalizeName(s.name), { id: s.id, name: s.name })
    }
    return out
  } catch (error) {
    logger.error('ensureSectionSkills: unexpected', error, { sectionId })
    return out
  }
}

/**
 * The skill pool of a set of modules: every concept their materials taught
 * (module_items.content.concepts, falling back to content.topics, plus the
 * module titles themselves), matched into the section's `skills` table.
 * Excluded skills are dropped; suppressed (suggested) ones are kept — tagging
 * one to an activity is exactly the corroboration that later promotes it.
 * Returns unique {id, name, context?} using the skill's stored display name;
 * `context` is the one-line concept summary from the extraction artifact when the
 * skill matched a concept (similarity tagging embeds it — see
 * suggestSkillsBySimilarity). Caller must have verified the modules belong to
 * the section (ids come from the client).
 *
 * When the tagged modules match NOTHING, this returns [] — never the whole
 * section pool. The old silent fallback made the required tagging step a no-op
 * in ~half the sections and suggested off-domain skills (#553-1); an honest
 * empty pool lets the UI say "no linked skills yet" and keeps questions
 * retaggable (an empty candidate list never persists skills: [], see
 * saveAssignmentRubric).
 */
export async function getModuleSkillCandidates(
  adminDb: AdminDb,
  sectionId: string,
  moduleIds: string[],
): Promise<Array<{ id: string; name: string; context?: string }>> {
  if (!moduleIds.length) return []
  try {
    const { data: skillRows, error: skillsError } = await adminDb
      .from('skills')
      .select('id, name, excluded')
      .eq('section_id', sectionId)
    if (skillsError) {
      logger.error('getModuleSkillCandidates: skills query failed', skillsError, { sectionId })
      return []
    }
    const skills = ((skillRows ?? []) as Array<{ id: string; name: string; excluded: boolean }>).filter((s) => !s.excluded)
    if (!skills.length) return []
    const pool = skills.map((s) => ({ id: s.id, canonical: canonicalizeName(s.name) }))
    const byId = new Map(skills.map((s) => [s.id, s.name]))

    const [itemsRes, modsRes] = await Promise.all([
      adminDb.from('module_items').select('content').in('module_id', moduleIds),
      adminDb.from('modules').select('title').in('id', moduleIds),
    ])
    if (itemsRes.error || modsRes.error) {
      logger.error('getModuleSkillCandidates: module query failed', itemsRes.error ?? modsRes.error, { sectionId })
      return []
    }
    const { data: items } = itemsRes
    const { data: mods } = modsRes
    const names = new Set<string>()
    // Concept summaries ride along: they give the skill name semantic context for
    // similarity tagging (bare 2-4 word names pun-match, e.g. "Node Types" ≈ "neural networks").
    const summaryByName = new Map<string, string>()
    for (const m of (mods ?? []) as Array<{ title: string | null }>) {
      if (m.title?.trim()) names.add(m.title.trim())
    }
    for (const it of (items ?? []) as Array<{ content: { concepts?: unknown; topics?: unknown } | null }>) {
      const concepts = Array.isArray(it.content?.concepts) ? it.content!.concepts : []
      for (const c of concepts as Array<{ name?: unknown; summary?: unknown }>) {
        if (typeof c?.name === 'string' && c.name.trim()) {
          names.add(c.name.trim())
          if (typeof c?.summary === 'string' && c.summary.trim() && !summaryByName.has(c.name.trim())) {
            summaryByName.set(c.name.trim(), c.summary.trim())
          }
        }
      }
      const topics = Array.isArray(it.content?.topics) ? it.content!.topics : []
      for (const t of topics as unknown[]) {
        if (typeof t === 'string' && t.trim()) names.add(t.trim())
      }
    }

    const out = new Map<string, { name: string; context?: string }>()
    for (const name of names) {
      const id = matchInPool(name, pool)
      if (id && !out.has(id)) out.set(id, { name: byId.get(id) ?? name, context: summaryByName.get(name) })
    }
    if (out.size === 0) {
      logger.warn('getModuleSkillCandidates: tagged modules match no section skills', {
        source: 'reconcile.getModuleSkillCandidates',
        sectionId,
        moduleCount: moduleIds.length,
        poolSize: skills.length,
      })
    }
    return [...out.entries()].map(([id, v]) => ({ id, name: v.name, ...(v.context ? { context: v.context } : {}) }))
  } catch (error) {
    logger.error('getModuleSkillCandidates: unexpected', error, { sectionId })
    return []
  }
}

/** Flatten a grading rubric (settings.rubric: { questions: [{ label, criteria:
 *  [{ description }] }] }) into its textual content for skill extraction. */
function rubricText(settings: Record<string, unknown> | null): string {
  try {
    const r = (settings as { rubric?: { questions?: Array<{ label?: string; criteria?: Array<{ description?: string }> }> } } | null)?.rubric
    const questions = r?.questions
    if (!Array.isArray(questions)) return ''
    return questions
      .map((q) => [q?.label, ...(q?.criteria ?? []).map((c) => c?.description)].filter(Boolean).join(' '))
      .join('\n')
  } catch {
    return ''
  }
}

/** Assemble an assignment's own text (title + description + guidelines + rubric)
 *  for concept extraction. Pure + testable. Capped so a huge brief can't blow up
 *  the model call (extractTopicsFromContent truncates further). */
export function assignmentSkillText(a: {
  title?: string | null
  description?: string | null
  guidelines?: string | null
  settings?: Record<string, unknown> | null
}): string {
  return [a.title, a.description, a.guidelines, rubricText(a.settings ?? null)]
    .filter((s): s is string => typeof s === 'string' && !!s.trim())
    .join('\n\n')
    .slice(0, 100_000)
}

/** Cheap deterministic FNV-1a hash of the assignment text, used as the cache key
 *  so an edited assignment re-extracts but an unchanged one is skipped. */
export function textHash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/**
 * AI-extract the concepts each assignment assesses, from its own text
 * (title/description/guidelines/rubric), across ALL of the section's assignments.
 * Result is cached per-assignment in `assignments.settings.skillExtraction`
 * (keyed by a text hash), so a background recompute only calls the model for a
 * new or edited assignment — an unchanged one reuses its cached names.
 * Best-effort: a model failure yields no names for that assignment, never throws.
 * With `aiAllowed === false` this is CACHE-ONLY: a hit is served, a miss yields
 * nothing and calls no model. Returns assignmentId → extracted concept names.
 */
async function extractAssignmentSkills(adminDb: AdminDb, sectionId: string, aiAllowed: boolean): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  try {
    const { data: asnRows } = await adminDb
      .from('assignments')
      .select('id, title, description, guidelines, settings')
      .eq('section_id', sectionId)
    const assignments = (asnRows ?? []) as Array<{
      id: string
      title: string | null
      description: string | null
      guidelines: string | null
      settings: Record<string, unknown> | null
    }>
    for (const a of assignments) {
      const text = assignmentSkillText(a)
      if (!text.trim()) continue
      const hash = textHash(text)
      const cache = (a.settings as { skillExtraction?: { hash?: string; names?: string[] } } | null)?.skillExtraction
      if (cache?.hash === hash && Array.isArray(cache.names)) {
        out.set(a.id, cache.names)
        continue
      }
      // AI off → cache-only. The write-through below is unreachable from here, so
      // a miss costs nothing and the next run after re-enable fills it in.
      if (!aiAllowed) continue
      const extracted = await extractTopicsFromContent(text)
      const names = extracted?.topics ?? []
      out.set(a.id, names)
      // Write-through cache, key-scoped via merge_assignment_settings (best-effort).
      //
      // Must NOT write the whole settings blob: `a.settings` was read before the awaited model
      // call above, so spreading it back would revert every key a professor touched in the
      // meantime (studio, rubric, rubricDraft, accepts, assessment, pdfs). This is a background
      // job, so that loss would be silent — their studio edits would just be gone on next load.
      const { error } = await adminDb.rpc('merge_assignment_settings', {
        p_assignment_id: a.id,
        p_section_id: sectionId,
        p_patch: { skillExtraction: { hash, names } },
      })
      if (error) logger.warn('extractAssignmentSkills: cache write failed', { sectionId, assignmentId: a.id })
    }
  } catch (error) {
    logger.error('extractAssignmentSkills: unexpected', error, { sectionId })
  }
  return out
}

export interface ReconcileResult {
  added: number // new concepts merged into the pool
  mapped: number // activity_skills rows auto-created
}

/**
 * Seed the section's skill pool from a module material's AI-extracted skills
 * (called by the extraction worker right after it writes content.skills).
 * Each new concept becomes a main skill; de-duped against the WHOLE pool —
 * including excluded AND suppressed rows, so a skill the professor dropped (or the
 * system already suggested/suppressed) never re-appears. Administrative names are
 * dropped by the deterministic backstop. New concepts seed as `suppressed=true`
 * (suggested) — the reconcile pass promotes the corroborated ones to tracked.
 * Best-effort + additive: never deletes or moves existing skills.
 */
export async function seedMaterialSkills(
  adminDb: AdminDb,
  moduleItemId: string,
  names: string[],
): Promise<number> {
  try {
    const cleaned = names.map((n) => (n || '').trim()).filter(Boolean)
    if (!cleaned.length) return 0

    // Resolve the owning section + institution from the module item.
    const { data: item } = await adminDb
      .from('module_items')
      .select('modules!inner(section_id, course_sections!inner(institution_id))')
      .eq('id', moduleItemId)
      .maybeSingle()
    const moduleRel = Array.isArray(item?.modules) ? item?.modules[0] : item?.modules
    const sectionId: string | undefined = moduleRel?.section_id
    const sectionRel = Array.isArray(moduleRel?.course_sections)
      ? moduleRel?.course_sections[0]
      : moduleRel?.course_sections
    const institutionId: string | undefined = sectionRel?.institution_id
    if (!sectionId || !institutionId) return 0

    const { data: skillRows } = await adminDb
      .from('skills')
      .select('id, name, parent_id, position')
      .eq('section_id', sectionId)
    const skills = (skillRows ?? []) as Array<{ id: string; name: string; parent_id: string | null; position: number }>
    const pool = skills.map((t) => ({ id: t.id, canonical: canonicalizeName(t.name) }))

    const newNames: string[] = []
    const seen = new Set<string>()
    for (const name of cleaned) {
      if (isNonConcept(name)) continue // backstop: drop course admin/structure + junk
      if (matchInPool(name, pool)) continue
      const key = canonicalizeName(name)
      if (!key || seen.has(key)) continue
      seen.add(key)
      newNames.push(name)
    }
    if (!newNames.length) return 0

    let position = Math.max(-1, ...skills.filter((t) => t.parent_id === null).map((t) => t.position)) + 1
    const rows = newNames.map((name) => ({
      section_id: sectionId,
      institution_id: institutionId,
      parent_id: null,
      name,
      source: 'ai',
      // Suggested, not tracked, until the reconcile corroboration gate promotes it.
      suppressed: true,
      position: position++,
    }))
    const { error } = await adminDb.from('skills').insert(rows)
    if (error) {
      logger.error('seedMaterialSkills: insert failed', error, { moduleItemId })
      return 0
    }
    return rows.length
  } catch (error) {
    logger.error('seedMaterialSkills: unexpected', error, { moduleItemId })
    return 0
  }
}

/**
 * Reconcile the section's skill pool across all sources and auto-derive the
 * quiz→skill mappings. Idempotent + additive.
 */
export async function reconcileSectionSkills(adminDb: AdminDb, sectionId: string): Promise<ReconcileResult> {
  try {
    const { data: section } = await adminDb
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .maybeSingle()
    if (!section?.institution_id) return { added: 0, mapped: 0 }
    const institutionId = section.institution_id as string

    /* Institution/platform AI kill switch — roadmap-skills-ai. Read ONCE (this
       module is uncached: every call is two PK lookups) and threaded as a FLAG,
       not an early return.

       It used to return here, which killed the whole function — including work
       that touches no model at all. An institution with AI off therefore got no
       activity_skills rows, so Topic Mastery never moved for anyone even when the
       professor hand-created every skill and hand-tagged every question. Same on
       any transient policy-read error, since the guard fails closed by design.
       AI off must stop AI, not stop the feature: the same "LMS-usable-minus-AI"
       rule quiz/irt/grader.ts states and suggestSkillPlacement already follows.

       `aiAllowed === false` turns off exactly three things:
         1. assignment concept extraction → CACHE-ONLY. A stored extraction is
            data already derived; only a cache MISS skips its model call.
         2. AI parent placement (bestParentId) → null, so a new concept becomes
            its own main. Identical to the manual-add path with AI off.
         3. the legacy-bucket dissolve → SKIPPED OUTRIGHT, never degraded. It
            re-homes children through bestParentId and then DELETES the bucket, so
            a null placement would irreversibly flatten every child. Deferred to
            the next AI-on run; the bucket surviving one more pass costs nothing.

       Everything else — library seed, junk suppression, candidate gathering, the
       quiz / assignment / live-quiz auto-maps, the corroboration gate and the
       library publish — is pure DB work and keeps running. */
    const aiVerdict = await checkAiFeature(adminDb, institutionId, 'roadmap-skills-ai')
    const aiAllowed = aiVerdict.allowed

    /* Minting a brand-new concept is gated on the REASON for the refusal, not on
       the refusal. A flat mint is permanent and it escapes the section: the dedup
       below skips any name already in the pool, so nothing ever re-parents it, and
       publishSectionSkillsToLibrary filters only on excluded/suppressed — not on
       source — so a flat `source:'ai'` row is published to the shared course
       library and seeded into sibling sections.

       A deliberate opt-out is indefinite, so a tag has to be allowed to score, and
       every section in that institution is flat anyway. A policy-read ERROR is
       transient and self-heals: the tags stay on quiz_questions.tags and the next
       run places them properly, so minting would trade a momentary gap for
       permanent, course-wide damage. */
    /* Only a deliberate CUSTOMER opt-out mints. 'global' and 'platform' are a
       Scholera-side emergency shutdown — transient in the same way a policy-read
       error is, so minting during one would buy a momentary gap at the price of
       permanent, course-wide flat skills. */
    const mintAllowed = aiVerdict.allowed || aiVerdict.lockedBy === 'institution'

    if (!aiVerdict.allowed) {
      logger.info('reconcileSectionSkills: AI off — deterministic pass only', {
        sectionId,
        institutionId,
        lockedBy: aiVerdict.lockedBy,
        skipped: [
          'assignment-extraction-misses',
          'ai-parent-placement',
          'legacy-bucket-dissolve',
          ...(mintAllowed ? [] : ['new-concept-minting']),
        ],
      })
      if (aiVerdict.lockedBy === 'error') {
        /* Fail-closed INFRA error, not a policy opt-out: the institution may have
           AI enabled and still be getting the degraded pass, which is the one case
           an operator needs surfaced. Policy opt-outs deliberately get NO events
           row — this function runs on every mastery recompute, including a nightly
           per-section sweep, so a row per run would flood the admin activity feed
           for a deliberate steady state. */
        void logEvent({
          userId: null, // actorless background job — logEvent's documented convention
          eventType: 'skill.reconcile_ai_unavailable',
          eventCategory: 'system',
          sectionId,
          metadata: { actor: 'mastery-recompute', institutionId, feature: 'roadmap-skills-ai', lockedBy: 'error' },
        })
      }
    }

    // ── Seed from the course library (issue #173) ──
    // A brand-new offering of a course starts from the concepts a previous
    // section already curated, instead of a blank list the professor re-types.
    // No-ops unless the pool is completely empty, so it runs safely on every
    // reconcile and can never fight curation — see lib/skills/library.ts.
    await seedSectionSkillsFromLibrary(adminDb, sectionId)

    // ── Current pool ──
    const { data: skillRows } = await adminDb
      .from('skills')
      .select('id, name, parent_id, position, source, excluded, suppressed')
      .eq('section_id', sectionId)
    const skills = (skillRows ?? []) as Array<{ id: string; name: string; parent_id: string | null; position: number; source: string; excluded: boolean; suppressed: boolean }>
    const pool = skills.map((t) => ({ id: t.id, canonical: canonicalizeName(t.name) }))

    // ── Backlog cleanup: demote junk that OLDER extraction tracked directly ──
    // Older imports seeded quiz/slide titles + test scaffolding straight into the
    // tracked pool (issue #382). Suppress those (source='ai' only — never touch a
    // professor-curated row) so they drop out of the tracked list. Reversible:
    // suppressed rows stay in the pool for de-dup and the professor can re-promote;
    // the corroboration gate below is guarded so they're not re-promoted next run.
    const junkTracked = skills.filter((t) => t.source === 'ai' && !t.suppressed && !t.excluded && isNonConcept(t.name))
    if (junkTracked.length) {
      const { error } = await adminDb.from('skills').update({ suppressed: true }).in('id', junkTracked.map((t) => t.id))
      if (error) logger.error('reconcileSectionSkills: junk suppression failed', error, { sectionId })
      else for (const t of junkTracked) t.suppressed = true // reflect locally so later passes see it
    }

    // ── Gather candidate concept names from every source ──
    const candidates = new Set<string>()

    // Quizzes / exams: the section question bank's per-question tags.
    const { data: questions } = await adminDb
      .from('quiz_questions')
      .select('tags')
      .eq('section_id', sectionId)
    for (const q of (questions ?? []) as Array<{ tags: string[] | null }>) {
      for (const tag of q.tags ?? []) if (tag && tag.trim()) candidates.add(tag.trim())
    }

    // Live-classroom quizzes: the rows are reused below to map each live quiz →
    // skills via each question's own `skillIds` (pool-grounded). Their TITLES are
    // deliberately NOT fed as candidates — a live-quiz title is a summary phrase
    // by construction ("QA Verify Scoped Quiz", "Lecture 4: …"), i.e. the exact
    // title-shaped junk issue #382 flags — so it must never mint a new concept.
    // lc_rooms → lc_interactions (kind='quiz'). rooms carry module_item_id for
    // inheritance fallback.
    const { data: rooms } = await adminDb.from('lc_rooms').select('id, module_item_id').eq('section_id', sectionId)
    const roomModuleItem = new Map<string, string | null>(
      ((rooms ?? []) as Array<{ id: string; module_item_id: string | null }>).map((r) => [r.id, r.module_item_id]),
    )
    const roomIds = [...roomModuleItem.keys()]
    type LiveQuizRow = { id: string; room_id: string; payload: { title?: string; questions?: Array<{ skillIds?: string[] }> } | null }
    let liveQuizRows: LiveQuizRow[] = []
    if (roomIds.length) {
      const { data: lq } = await adminDb
        .from('lc_interactions')
        .select('id, room_id, payload')
        .eq('kind', 'quiz')
        .in('room_id', roomIds)
      liveQuizRows = (lq ?? []) as LiveQuizRow[]
    }

    // Assignments: AI-extracted concepts from each assignment's own text (cached
    // per-assignment). Feed the names into the pool; keep the per-assignment map
    // for the assignment→skill mapping step below.
    const asnSkillNames = await extractAssignmentSkills(adminDb, sectionId, aiAllowed)
    for (const names of asnSkillNames.values()) {
      for (const t of names) if (t && t.trim()) candidates.add(t.trim())
    }

    // ── De-dup against the pool; collect genuinely-new concepts ──
    const newNames: string[] = []
    const seenNew = new Set<string>()
    for (const name of candidates) {
      if (isNonConcept(name)) continue // backstop: drop course admin/structure + junk
      if (matchInPool(name, pool)) continue // already represented — dedup
      const key = canonicalizeName(name)
      if (!key || seenNew.has(key)) continue
      seenNew.add(key)
      newNames.push(name)
    }

    // No dedicated bucket: new concepts AI-place under the best-fitting existing
    // main (same brain as the manual "Add skill" placement); if none fits, a
    // concept becomes its own new main. Imported + hand-added skills thus live in
    // one organized list. Placement targets are the tracked mains, EXCLUDING any
    // legacy "Imported from activities" bucket (dissolved just below).
    const legacyBucket = skills.find(
      (t) => t.parent_id === null && canonicalizeName(t.name) === canonicalizeName('Imported from activities'),
    )
    const mainRows = skills.filter(
      (t) => t.parent_id === null && !t.excluded && !t.suppressed && t.id !== legacyBucket?.id,
    )
    const mainIdByCanonical = new Map(mainRows.map((t) => [canonicalizeName(t.name), t.id]))
    const mainNames = mainRows.map((t) => t.name)
    let maxMainPos = Math.max(-1, ...mainRows.map((t) => t.position))
    const subCountByParent = new Map<string, number>()

    /** Best existing main for a concept (AI), or null → it's a distinct main.
     *  AI off → always null, so the concept becomes its own main: the same
     *  degradation suggestSkillPlacement already ships for a manual add. */
    const bestParentId = async (name: string): Promise<string | null> => {
      if (!aiAllowed || !mainNames.length) return null
      const parentName = await suggestSkillParent(name, mainNames, { sectionId })
      return parentName ? mainIdByCanonical.get(canonicalizeName(parentName)) ?? null : null
    }

    // One-time migration: dissolve a legacy bucket by re-homing its children
    // (AI-placed under the best main, else promoted to their own main) and
    // deleting the now-empty bucket. Re-homing (not delete+recreate) preserves
    // skill ids → activity mappings + mastery survive.
    // Requires AI: re-homing goes through bestParentId and then DELETES the
    // bucket. With AI off every child would place null and be flattened to a
    // top-level main, and the delete makes that irreversible — so this is the one
    // block that is skipped rather than degraded.
    if (legacyBucket && aiAllowed) {
      for (const child of skills.filter((t) => t.parent_id === legacyBucket.id)) {
        const parentId = await bestParentId(child.name)
        const patch: Record<string, unknown> = { parent_id: parentId }
        if (!parentId) { maxMainPos += 1; patch.position = maxMainPos }
        const { error } = await adminDb.from('skills').update(patch).eq('id', child.id)
        if (error) logger.error('reconcileSectionSkills: legacy bucket re-home failed', error, { sectionId, child: child.name })
      }
      const { error } = await adminDb.from('skills').delete().eq('id', legacyBucket.id)
      if (error) logger.error('reconcileSectionSkills: legacy bucket delete failed', error, { sectionId })
    }

    let added = 0
    if (newNames.length && mintAllowed) {
      for (const name of newNames) {
        const parentId = await bestParentId(name)
        if (parentId) {
          const position = subCountByParent.get(parentId) ?? 0
          subCountByParent.set(parentId, position + 1)
          const { error } = await adminDb
            .from('skills')
            .insert({ section_id: sectionId, institution_id: institutionId, parent_id: parentId, name, source: 'ai', position })
          if (error) logger.error('reconcileSectionSkills: import subtopic insert failed', error, { sectionId, name })
          else added += 1
        } else {
          // Becomes its own new main — insert now so later concepts this run can
          // nest under it too.
          maxMainPos += 1
          const { data: ins, error } = await adminDb
            .from('skills')
            .insert({ section_id: sectionId, institution_id: institutionId, parent_id: null, name, source: 'ai', position: maxMainPos })
            .select('id')
            .single()
          if (error || !ins) logger.error('reconcileSectionSkills: import main insert failed', error, { sectionId, name })
          else {
            added += 1
            mainNames.push(name)
            mainIdByCanonical.set(canonicalizeName(name), ins.id)
          }
        }
      }
    }

    // ── Auto-map quizzes → pool skills (replaces the manual mapping tab) ──
    // Refresh the pool index (now includes any imported concepts).
    const { data: poolRows2 } = await adminDb.from('skills').select('id, name').eq('section_id', sectionId)
    /* Longest canonical first, then id — the same ordering recompute.ts and
       grade-hook.ts apply. matchInPool returns the FIRST substring hit and this
       query has no ORDER BY, so without it an ambiguous tag could map an activity
       to a different skill on two runs of the same data, and the two scoring paths
       would agree with each other about a mapping that itself drifts. */
    const pool2 = ((poolRows2 ?? []) as Array<{ id: string; name: string }>)
      .map((t) => ({ id: t.id, canonical: canonicalizeName(t.name) }))
      .sort((a, b) => b.canonical.length - a.canonical.length || a.id.localeCompare(b.id))

    // questionId → its pool skill ids (resolved from the question's tags).
    // Paged: a section's question bank routinely passes 1000, and a question the
    // read drops takes its tags — and therefore its skill attribution — with it.
    const qRows = await readAllPages<{ id: string; tags: string[] | null }>(
      () => adminDb.from('quiz_questions').select('id, tags').eq('section_id', sectionId),
      'id',
      'reconcileSectionSkills.quiz_questions',
    )
    const skillIdsForQuestion = new Map<string, string[]>()
    for (const q of (qRows ?? []) as Array<{ id: string; tags: string[] | null }>) {
      const ids = new Set<string>()
      for (const tag of q.tags ?? []) {
        const id = matchInPool(tag, pool2)
        if (id) ids.add(id)
      }
      if (ids.size) skillIdsForQuestion.set(q.id, [...ids])
    }

    let mapped = 0
    if (skillIdsForQuestion.size) {
      const { data: quizzes } = await adminDb.from('quizzes').select('id').eq('section_id', sectionId)
      const quizIds = ((quizzes ?? []) as Array<{ id: string }>).map((q) => q.id)
      if (quizIds.length) {
        // Resolve each quiz's question set from its attempts (resolved_question_ids).
        // Paged: this is students × quizzes, so it crosses PostgREST's silent
        // 1000-row cap in any real section. Truncated, the quizzes past the cut
        // never get an activity_skills row at all — their grades then move no
        // mastery, and nothing anywhere reports that they were skipped.
        const attempts = await readAllPages<{ quiz_id: string; resolved_question_ids: string[] | null }>(
          () => adminDb.from('quiz_attempts').select('quiz_id, resolved_question_ids, id').in('quiz_id', quizIds),
          'id',
          'reconcileSectionSkills.quiz_attempts',
        )
        const questionIdsForQuiz = new Map<string, Set<string>>()
        for (const a of (attempts ?? []) as Array<{ quiz_id: string; resolved_question_ids: string[] | null }>) {
          const set = questionIdsForQuiz.get(a.quiz_id) ?? new Set<string>()
          for (const qid of a.resolved_question_ids ?? []) set.add(qid)
          questionIdsForQuiz.set(a.quiz_id, set)
        }

        const mapRows: Array<Record<string, unknown>> = []
        for (const [quizId, qids] of questionIdsForQuiz) {
          const skillIds = new Set<string>()
          for (const qid of qids) for (const tid of skillIdsForQuestion.get(qid) ?? []) skillIds.add(tid)
          for (const tid of skillIds) {
            mapRows.push({ section_id: sectionId, institution_id: institutionId, activity_id: quizId, activity_type: 'quiz', skill_id: tid })
          }
        }
        if (mapRows.length) {
          // Additive: don't clobber professor/seeded mappings.
          const { error } = await adminDb
            .from('activity_skills')
            .upsert(mapRows, { onConflict: 'activity_type,activity_id,skill_id', ignoreDuplicates: true })
          if (error) logger.error('reconcileSectionSkills: mapping upsert failed', error, { sectionId })
          else mapped = mapRows.length
        }
      }
    }

    // ── Auto-map assignments → skills ──
    // Primary: the assignment's own AI-extracted concepts (asnSkillNames),
    // resolved to pool skills. Fallback: inherit the linked module's taught
    // skills (assignmentSkillMappings). Both additive/idempotent, unioned per
    // (assignment, skill) so a linked assignment gets both signals.
    {
      const seen = new Set<string>() // `${activityId}:${skillId}`
      const asnMap: Array<Record<string, unknown>> = []
      const pushMap = (activityId: string, skillId: string) => {
        const key = `${activityId}:${skillId}`
        if (seen.has(key)) return
        seen.add(key)
        asnMap.push({ section_id: sectionId, institution_id: institutionId, activity_id: activityId, activity_type: 'assignment', skill_id: skillId })
      }

      // AI-extracted → matched pool skills.
      for (const [activityId, names] of asnSkillNames) {
        const { matchedIds } = resolveSkillNames(names, pool2)
        for (const skillId of matchedIds) pushMap(activityId, skillId)
      }

      // Module inheritance fallback (only assignments linked to a module).
      const { data: asnRows } = await adminDb
        .from('assignments')
        .select('id, module_id')
        .eq('section_id', sectionId)
        .not('module_id', 'is', null)
      const assignments = (asnRows ?? []) as Array<{ id: string; module_id: string | null }>
      if (assignments.length) {
        const moduleIds = [...new Set(assignments.map((a) => a.module_id).filter((m): m is string => !!m))]
        const { data: modItems } = await adminDb
          .from('module_items')
          .select('module_id, content')
          .in('module_id', moduleIds)
        const topicsByModule = new Map<string, string[]>()
        for (const it of (modItems ?? []) as Array<{ module_id: string; content: { topics?: unknown } | null }>) {
          const topics = Array.isArray(it.content?.topics)
            ? (it.content!.topics as unknown[]).filter((t): t is string => typeof t === 'string' && !!t.trim())
            : []
          if (topics.length) topicsByModule.set(it.module_id, [...(topicsByModule.get(it.module_id) ?? []), ...topics])
        }
        for (const m of assignmentSkillMappings(assignments, topicsByModule, pool2)) pushMap(m.activityId, m.skillId)
      }

      if (asnMap.length) {
        const { error } = await adminDb
          .from('activity_skills')
          .upsert(asnMap, { onConflict: 'activity_type,activity_id,skill_id', ignoreDuplicates: true })
        if (error) logger.error('reconcileSectionSkills: assignment mapping upsert failed', error, { sectionId })
        else mapped += asnMap.length
      }
    }

    // ── Auto-map live-classroom quizzes → skills (activity_type='live_quiz') ──
    // Primary: each quiz question's own skill tags (payload.questions[].skillIds,
    // set by the professor or AI). Fallback: inherit the room's linked module item
    // (lc_rooms.module_item_id → module_items.content.topics). Additive/idempotent.
    // Mirrors quizzes/assignments so coverage + mastery share activity_skills.
    if (liveQuizRows.length) {
      const itemIds = [...new Set([...roomModuleItem.values()].filter((m): m is string => !!m))]
      const skillsByItem = new Map<string, string[]>()
      if (itemIds.length) {
        const { data: modItems } = await adminDb.from('module_items').select('id, content').in('id', itemIds)
        for (const it of (modItems ?? []) as Array<{ id: string; content: { topics?: unknown } | null }>) {
          const ids = new Set<string>()
          const topics = Array.isArray(it.content?.topics)
            ? (it.content!.topics as unknown[]).filter((t): t is string => typeof t === 'string' && !!t.trim())
            : []
          for (const t of topics) { const id = matchInPool(t, pool2); if (id) ids.add(id) }
          if (ids.size) skillsByItem.set(it.id, [...ids])
        }
      }
      const poolIds = new Set(pool2.map((p) => p.id))
      const seen = new Set<string>()
      const lqMap: Array<Record<string, unknown>> = []
      const push = (activityId: string, skillId: string) => {
        const key = `${activityId}:${skillId}`
        if (seen.has(key)) return
        seen.add(key)
        lqMap.push({ section_id: sectionId, institution_id: institutionId, activity_id: activityId, activity_type: 'live_quiz', skill_id: skillId })
      }
      for (const q of liveQuizRows) {
        // Per-question skill tags (already section skill ids) — keep pool members.
        for (const question of q.payload?.questions ?? [])
          for (const sid of question.skillIds ?? []) if (poolIds.has(sid)) push(q.id, sid)
        // Inheritance fallback from the room's linked module item.
        for (const sid of skillsByItem.get(roomModuleItem.get(q.room_id) ?? '') ?? []) push(q.id, sid)
      }
      if (lqMap.length) {
        const { error } = await adminDb
          .from('activity_skills')
          .upsert(lqMap, { onConflict: 'activity_type,activity_id,skill_id', ignoreDuplicates: true })
        if (error) logger.error('reconcileSectionSkills: live-quiz mapping upsert failed', error, { sectionId })
        else mapped += lqMap.length
      }
    }

    // ── Corroboration gate: promote suggested (suppressed) AI concepts ──
    // A suggested concept becomes TRACKED once it's corroborated: it appears in
    // ≥2 course materials, is linked to an activity, or is the section's only
    // material (nothing to corroborate against). Promotion-only — never demotes a
    // tracked skill, so it can't override the professor's own choices.
    {
      // Exclude junk from promotion: a junk row that's activity-linked would
      // otherwise be re-promoted every run, undoing the backlog suppression above.
      const suggested = skills.filter((s) => s.source === 'ai' && s.suppressed && !s.excluded && !isNonConcept(s.name))
      if (suggested.length) {
        const { data: allItems } = await adminDb
          .from('module_items')
          .select('id, content, modules!inner(section_id)')
          .eq('modules.section_id', sectionId)
        const items = (allItems ?? []) as Array<{ content: { topics?: unknown } | null }>
        const materialCountByCanon = new Map<string, number>()
        let materialsWithTopics = 0
        for (const it of items) {
          const topics = Array.isArray(it.content?.topics)
            ? (it.content!.topics as unknown[]).filter((t): t is string => typeof t === 'string' && !!t.trim())
            : []
          if (!topics.length) continue
          materialsWithTopics++
          const seenHere = new Set<string>()
          for (const t of topics) {
            const c = canonicalizeName(t)
            if (!c || seenHere.has(c)) continue
            seenHere.add(c)
            materialCountByCanon.set(c, (materialCountByCanon.get(c) ?? 0) + 1)
          }
        }
        const { data: actRows } = await adminDb.from('activity_skills').select('skill_id').eq('section_id', sectionId)
        const linkedSkillIds = new Set(((actRows ?? []) as Array<{ skill_id: string }>).map((r) => r.skill_id))
        const onlySource = materialsWithTopics <= 1

        const promoteIds = suggested
          .filter((s) => onlySource || linkedSkillIds.has(s.id) || (materialCountByCanon.get(canonicalizeName(s.name)) ?? 0) >= 2)
          .map((s) => s.id)
        if (promoteIds.length) {
          const { error } = await adminDb.from('skills').update({ suppressed: false }).in('id', promoteIds)
          if (error) logger.error('reconcileSectionSkills: promotion update failed', error, { sectionId })
        }
      }
    }

    // ── Publish back up to the course library (issue #173) ──
    // Last step, so it sees this run's promotions and mappings. Only TRACKED
    // skills go up, and nothing is ever deleted from the library. Publishing here
    // rather than only from the curate action means every path that curates a
    // pool — the review modal, a hand-added skill, a promotion — eventually
    // reaches the library without each one needing its own hook.
    await publishSectionSkillsToLibrary(adminDb, sectionId)

    return { added, mapped }
  } catch (error) {
    logger.error('reconcileSectionSkills: unexpected', error, { sectionId })
    return { added: 0, mapped: 0 }
  }
}
