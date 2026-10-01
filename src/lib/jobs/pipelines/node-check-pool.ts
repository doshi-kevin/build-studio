// node_check_pool — generates one supplementary item's question pool
// (docs/designs/roadmap-mastery/roadmap-engine.md §14).
//
// Lazy by design: enqueued by the first student who opens the node, not at
// upload. Material nobody opens costs nothing, which matters because a course
// can carry dozens of papers and links that no one ever touches.
//
// Tenant scope (institution_id / section_id) comes from the JOB ROW, written by
// the enqueueing action from a verified section — never from params.

import 'server-only'

import { z } from 'zod'

import { logger } from '@/lib/logger'
import { generateNodeCheck, type NodeCheckSource } from '@/lib/ai/node-check'
import { NODE_CHECK_POOL_SIZE } from '@/lib/ai/config'
import type { BackgroundPipeline, PipelineContext, PipelineResult } from '../types'

export const NODE_CHECK_POOL_JOB_TYPE = 'node_check_pool'

const paramsSchema = z.object({ moduleItemId: z.string().min(1) })

/** The slice of `module_items.content` the generator reuses. */
interface ItemContent {
  summary?: string
  concepts?: { name?: string; summary?: string }[]
  topics?: string[]
}

async function setState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  moduleItemId: string,
  state: 'pending' | 'ready' | 'not_quizzable' | 'failed',
  poolVersion?: number,
): Promise<void> {
  const patch: Record<string, unknown> = { node_check_state: state }
  if (poolVersion !== undefined) patch.node_check_pool_version = poolVersion
  await adminDb.from('module_items').update(patch).eq('id', moduleItemId)
}

async function run(
  params: Record<string, unknown>,
  ctx: PipelineContext,
): Promise<PipelineResult> {
  const { moduleItemId } = paramsSchema.parse(params)
  const { adminDb, job } = ctx
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = adminDb as any

  // Deliberately NOT selecting instructor_note: the item editor labels it
  // "Instructor Note (private)" and hides it from students, but generated
  // questions are rendered TO students — feeding it in would quietly publish a
  // field the UI promises is private ("this is what the exam draws from").
  const { data: item } = await db
    .from('module_items')
    .select('id, title, description, content, node_check_pool_version, module:modules!inner(section_id)')
    .eq('id', moduleItemId)
    .maybeSingle()

  if (!item) {
    // The professor deleted it while the job sat in the queue — nothing to do,
    // and the row's cascade already removed any pool.
    return { result: { skipped: 'item-missing' }, summary: 'Item no longer exists' }
  }

  // Defence in depth: the one enqueue site already proves the item is in the
  // section, but this job writes rows stamped with the JOB's tenant, so a second
  // caller added later must not be able to file another course's content here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const itemModule = Array.isArray((item as any).module) ? (item as any).module[0] : (item as any).module
  if (job.section_id && itemModule?.section_id !== job.section_id) {
    logger.warn('node_check_pool: item outside the job section — skipping', { moduleItemId })
    return { result: { skipped: 'section-mismatch' }, summary: 'Item is not in this course' }
  }

  const content = (item.content ?? {}) as ItemContent
  const src: NodeCheckSource = {
    title: item.title || 'Untitled',
    // Supplementary material carries no extraction, so the professor's blurb is
    // usually the only source there is — see NodeCheckSource.
    description: item.description || undefined,
    summary: content.summary,
    concepts: (content.concepts ?? [])
      .filter((c): c is { name: string; summary?: string } => !!c?.name)
      .map((c) => ({ name: c.name, summary: c.summary })),
    topics: content.topics,
  }

  let generated
  try {
    generated = await generateNodeCheck(src, {
      institutionId: job.institution_id,
      sectionId: job.section_id,
    })
  } catch (error) {
    logger.error('node_check_pool: generation failed', error, { moduleItemId })
    await setState(db, moduleItemId, 'failed')
    throw error
  }

  if (generated.notQuizzable) {
    // Not an error: a syllabus or a format guide has no comprehension to test,
    // so the node quietly falls back to a self check-off (§14.1).
    await setState(db, moduleItemId, 'not_quizzable')
    return { result: { notQuizzable: true }, summary: 'Nothing worth testing — self check-off' }
  }

  const poolVersion = (item.node_check_pool_version ?? 0) + 1

  const { error: insertError } = await db.from('node_check_questions').insert(
    generated.questions.slice(0, NODE_CHECK_POOL_SIZE).map((q) => ({
      institution_id: job.institution_id,
      section_id: job.section_id,
      module_item_id: moduleItemId,
      prompt: q.prompt,
      choices: q.choices,
      answer_index: q.answerIndex,
      pool_version: poolVersion,
    })),
  )

  if (insertError) {
    logger.error('node_check_pool: insert failed', insertError, { moduleItemId })
    await setState(db, moduleItemId, 'failed')
    throw new Error('Failed to store the question pool')
  }

  // Flip to ready ONLY after the rows land, so a reader never sees 'ready'
  // against an empty pool.
  await setState(db, moduleItemId, 'ready', poolVersion)

  return {
    result: { moduleItemId, count: generated.questions.length, poolVersion },
    summary: `Prepared ${generated.questions.length} check questions`,
  }
}

export const nodeCheckPoolPipeline: BackgroundPipeline = {
  type: NODE_CHECK_POOL_JOB_TYPE,
  run,
}
