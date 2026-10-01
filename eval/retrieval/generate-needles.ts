/**
 * Generate the needle set — one paraphrased question per sampled corpus page.
 *
 *   npm run eval:needles:generate                 # ~100 needles, deterministic sample
 *   npm run eval:needles:generate -- --count=40
 *   npm run eval:needles:generate -- --dry-run    # print, don't write
 *
 * Run by hand, output committed. Regeneration costs a few cents and produces a
 * DIFFERENT set (the model doesn't repeat itself), so re-run it when the corpus
 * changes, not casually — a changed needle set moves the baseline for reasons
 * that have nothing to do with retrieval.
 *
 * Sampling is a deterministic stride over pages ordered by (material, page), not
 * a random draw: the same corpus always samples the same pages, so a regenerated
 * set differs only in its wording. Pages too short to hold a question are
 * skipped, and so is the first page of every material (title slides generate
 * "what is this lecture about", which every page in the deck answers).
 */

import { writeFileSync } from 'node:fs'

import { generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { z } from 'zod'

import { TOPIC_EXTRACTION_MODEL } from '@/lib/ai/config'
import { createAdminClient } from '@/lib/supabase/admin'

import { leakedTerms, NEEDLES_PATH, type Needle, type NeedleSet } from './needles'

/** Below this a page is a section divider or a figure caption — nothing to ask about. */
const MIN_PAGE_CHARS = 400
/** Above this the page is truncated for the prompt; the question only needs the substance. */
const MAX_PAGE_CHARS = 6000
const DEFAULT_COUNT = 100
const CONCURRENCY = 4

const needleSchema = z.object({
  question: z
    .string()
    .describe('The student-style question, answerable only from this page, using none of the banned terms'),
  banned: z
    .array(z.string())
    .describe('The distinctive terms from this page that the question must avoid'),
})

const SYSTEM = `You write evaluation questions for a university course search engine.

You are given ONE page of course material. Produce a question a student in this course would plausibly type, whose answer is on THIS page.

Rules:
1. First list the page's DISTINCTIVE terms — the named concepts, formulas, acronyms and jargon that make this page findable by keyword (e.g. "scaled dot-product attention", "KV cache", "BLEU", "Q, K, V").
2. Then write a question that uses NONE of those terms, not even partially. Describe the idea in ordinary words instead ("why do we divide the attention scores by the square root of the dimension" rather than "what is scaled dot-product attention").
3. The question must still be specific enough that this page answers it and other pages don't. A question so vague that any page answers it is useless.
4. Write it the way a student types — one sentence, lower-case is fine, no "according to the slides".
5. Never mention the page number, the lecture number, or the document title.`

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

interface CorpusPage {
  moduleItemId: string
  material: string
  page: number
  text: string
}

/** Every indexed page of the eval section, in a stable order. */
async function loadCorpus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  sectionId: string,
): Promise<CorpusPage[]> {
  const { data: items, error: itemError } = await admin
    .from('module_items')
    .select('id, title, modules!inner(section_id)')
    .eq('modules.section_id', sectionId)
  if (itemError) throw new Error(`could not read module_items: ${itemError.message}`)
  const titleById = new Map<string, string>(
    ((items ?? []) as Array<{ id: string; title: string | null }>).map((i) => [i.id, (i.title ?? '').trim()]),
  )

  const { data: chunks, error } = await admin
    .from('material_vector_chunks')
    .select('module_item_id, page_number, content')
    .eq('section_id', sectionId)
    .eq('status', 'indexed')
  if (error) throw new Error(`could not read material_vector_chunks: ${error.message}`)

  const pages = ((chunks ?? []) as Array<{ module_item_id: string; page_number: number; content: string }>)
    .filter((c) => titleById.has(c.module_item_id))
    .map((c) => ({
      moduleItemId: c.module_item_id,
      material: titleById.get(c.module_item_id) as string,
      page: c.page_number,
      text: (c.content ?? '').trim(),
    }))
    .filter((p) => p.material && p.page > 1 && p.text.length >= MIN_PAGE_CHARS)

  // Deterministic order — the sample below is a stride, so the order IS the seed.
  pages.sort((a, b) => (a.material === b.material ? a.page - b.page : a.material.localeCompare(b.material)))
  return pages
}

/** Even stride across the ordered corpus, so every material contributes. */
function sample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items
  const step = items.length / count
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)])
}

async function writeNeedle(page: CorpusPage): Promise<Needle | null> {
  const prompt = `Course material page (title withheld on purpose):\n\n${page.text.slice(0, MAX_PAGE_CHARS)}`

  // One retry, and only for the leak case: the model reliably produces a good
  // question but sometimes cannot resist the term it just listed as banned.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: google(TOPIC_EXTRACTION_MODEL),
        schema: needleSchema,
        system: SYSTEM,
        prompt:
          attempt === 0
            ? prompt
            : `${prompt}\n\nYour previous attempt reused a banned term. Rewrite the question describing the idea in plain words instead.`,
        temperature: 0.4,
      })
      const question = object.question.trim()
      const banned = object.banned.map((b) => b.trim()).filter(Boolean)
      if (question.length < 15) continue
      if (leakedTerms(question, banned).length > 0) continue
      return {
        id: `needle-${slug(page.material)}-p${page.page}`,
        material: page.material,
        page: page.page,
        query: question,
        banned,
      }
    } catch (err) {
      console.warn(`  ! ${page.material} p.${page.page}: ${(err as Error).message}`)
      return null
    }
  }
  return null
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const dryRun = args.includes('--dry-run')

  const sectionId = env('EVAL_SECTION_ID')
  const institutionId = env('EVAL_INSTITUTION_ID')
  if (!sectionId || !institutionId) {
    throw new Error('set EVAL_SECTION_ID and EVAL_INSTITUTION_ID (the seeded eval course) in .env.local')
  }
  const url = env('NEXT_PUBLIC_SUPABASE_URL') ?? ''
  const local = /127\.0\.0\.1|localhost/.test(url)
  const remoteOverride = env('EVAL_ALLOW_REMOTE') === '1'
  if (!local && !remoteOverride) {
    throw new Error(`refusing to read a non-local corpus (${url || 'no URL'}) — set EVAL_ALLOW_REMOTE=1 to override`)
  }
  /* The override lets you READ a remote dev corpus; it does not let you write
     one into git. `needles.json` is the only committed artifact in this harness
     derived from page CONTENT — a hundred questions written from a hundred real
     pages — so generating it from a live tenant's materials would commit a
     paraphrase of their course. `--dry-run` still prints. */
  if (!local && !dryRun) {
    throw new Error(
      `refusing to WRITE needles.json from a non-local corpus (${url}).\n` +
        `Every question is generated from real page text, and this file gets committed.\n` +
        `Re-run against the local seed, or add --dry-run to inspect without writing.`,
    )
  }

  const count = Number(value('count') ?? DEFAULT_COUNT)
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new Error(`--count must be an integer 1..500, got "${value('count')}"`)
  }

  const admin = createAdminClient()
  /* Label the corpus by course, not by section id: golden.json is deliberately
     UUID-free so a re-seed can't rot it, and a raw tenant id has no business in
     a committed artifact either. */
  const { data: section } = await admin
    .from('course_sections')
    .select('section_code, course:courses(code, title)')
    .eq('id', sectionId)
    .single()
  const joined = (section as { course?: unknown } | null)?.course
  const course = (Array.isArray(joined) ? joined[0] : joined) as { code?: string; title?: string } | undefined
  const courseLabel = [course?.code, course?.title].filter(Boolean).join(' ') || 'unknown course'

  const corpus = await loadCorpus(admin, sectionId)
  if (corpus.length === 0) {
    throw new Error(`no indexed pages with ≥${MIN_PAGE_CHARS} characters in section ${sectionId}`)
  }
  const sampled = sample(corpus, count)
  console.log(
    `corpus ${corpus.length} usable pages across ${new Set(corpus.map((p) => p.material)).size} materials · ` +
      `sampling ${sampled.length} · model ${TOPIC_EXTRACTION_MODEL}`,
  )

  const generated = (await mapWithConcurrency(sampled, CONCURRENCY, writeNeedle)).filter(
    (n): n is Needle => n !== null,
  )
  // The stride can land twice on the same page id only if the corpus has
  // duplicate (material, page) rows; drop rather than fail the whole run.
  const unique = [...new Map(generated.map((n) => [n.id, n])).values()]

  console.log(`\ngenerated ${unique.length} needles (${sampled.length - unique.length} skipped)`)
  for (const n of unique.slice(0, 5)) {
    console.log(`  · ${n.material} p.${n.page}\n      "${n.query}"\n      banned: ${n.banned.join(', ')}`)
  }
  if (unique.length > 5) console.log(`  … and ${unique.length - 5} more`)

  if (dryRun) {
    console.log('\n--dry-run — nothing written')
    return 0
  }

  const set: NeedleSet = {
    corpus: `${courseLabel} — ${corpus.length} usable pages`,
    generator: TOPIC_EXTRACTION_MODEL,
    generated: new Date().toISOString().slice(0, 10),
    needles: unique.sort((a, b) => a.id.localeCompare(b.id)),
  }
  writeFileSync(NEEDLES_PATH, JSON.stringify(set, null, 2) + '\n')
  console.log(`\nwrote eval/retrieval/needles.json — commit it, then re-record the needle baseline`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
