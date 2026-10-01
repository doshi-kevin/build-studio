/**
 * `map_knowledge_path` — "what do I need to understand X?" answered on the map.
 *
 * The second `create` tool (design doc §15's mechanism, §16's feature). The
 * student names a concept; the model proposes the prerequisite concepts it
 * thinks come first, in order, each with one line of why. This tool is the half
 * that keeps that honest:
 *
 *   LLM picks, the GRAPH validates. Every proposed title is matched against the
 *   REAL roadmap nodes of the verified section (`knowledge-path.ts`, pure). A
 *   title matching nothing is dropped; fewer than two survivors, or a question
 *   naming nothing on this roadmap, is a CORRECTION rather than a shorter
 *   invented path — the model then answers in prose and claims nothing.
 *
 * The model never supplies a node key or an id. It supplies concept titles,
 * which are content; the keys come from this section's own nodes and the
 * ordering from the professor's own `prerequisite` edges.
 *
 * The path persists as an `athena_artifacts` row (kind `knowledge_map`) so it
 * survives the student closing the lens, and the drive is the ordinary
 * `goto_page` directive at the typed roadmap route. Copilot mode only, for the
 * same reason `leave_study_artifact` is: it puts something on the roadmap.
 */

import { z } from 'zod'
import { logger } from '@/lib/logger'
import { ARTIFACT_KIND_META, type KnowledgeMapPayload } from '@/lib/athena/artifact-kinds'
import { buildNodeJourneys } from '@/lib/roadmap/node-journeys'
import { courseVocabulary, resolveKnowledgePath, type PrereqEdge } from '@/lib/roadmap/knowledge-path'
import { studentRoute } from '@/lib/routes/student'
import { saveArtifact } from './artifact-store'
import { defineStudentTool, type AthenaStudentCtx } from './contract'

/** A path with one stop is a sentence, not a map — below this the answer is
 *  better as prose, and drawing a lens over one node is noise. */
const MIN_STOPS = 2
/** Enough edges to order any realistic course's map in one bounded read. */
const MAX_EDGES = 1000

const INPUT = z.object({
  question: z.string().min(1).max(300)
    .describe("The student's question, in their own words — e.g. \"what do I need to understand transformer attention?\". Used to find the concept they are asking ABOUT on their roadmap."),
  concepts: z.array(z.object({
    title: z.string().min(1).max(120)
      .describe('The prerequisite concept, named as closely as you can to how it appears in the course materials — a lecture title or a topic label. Titles that match no material on this course\'s roadmap are dropped.'),
    why: z.string().min(1).max(200)
      .describe('One line on why this comes first — what it gives the student that the next step needs.'),
  })).min(MIN_STOPS).max(8)
    .describe('The prerequisite concepts, ordered FOUNDATIONAL FIRST and ending just before the concept they asked about. Propose 3–6, drawn from this course\'s materials.'),
})

type Input = z.infer<typeof INPUT>

type Result =
  | {
      mapped: true
      focus: string
      stops: { material: string; why: string; masteryPercent: number | null }[]
      note: string
    }
  /** A refusal always carries the course's real vocabulary. The first live test
   *  failed because the model proposed textbook concept names ("Word Embeddings",
   *  "Encoder-Decoder Architecture") against a course whose nodes are titled
   *  "Lecture 3: Word Vectors" and "Lecture 5: Seq2Seq and Attention" — nothing
   *  matched, and the model had no way to know why. Handing back the names makes
   *  the refusal actionable in one retry instead of terminal. */
  | { mapped: false; reason: string; candidates?: string[] }

/** `${type}:${id}` — the canvas key form both roadmap-edge endpoints and node
 *  refs use, so an edge can be compared to a node without parsing either. */
const edgeKey = (type: string, id: string) => `${type}:${id}`

export const mapKnowledgePath = defineStudentTool({
  name: 'map_knowledge_path',
  kind: 'create',
  label: 'A path to that concept',
  description:
    "Build a prerequisite PATH through this student's own course roadmap to a concept they asked about, save it, and light it up on the map for them. Call this when the student asks what they need to understand X, what they should learn or know BEFORE X, what leads up to X, what the prerequisites for X are, or how to work up to X. You supply the student's question and 3–6 prerequisite concepts you think come first, ordered foundational-first, each with one line on why — draw the concept names from THIS course's materials and lecture titles, as closely worded as you can. The server keeps only the ones that match real material on this student's roadmap and orders them by the professor's own prerequisite links; it never invents a node. If it reports back that too little matched, say so plainly and answer the question in prose instead — do not claim you mapped anything.",
  input: INPUT,
  describe: (r: Result) =>
    r.mapped ? `${r.stops.length} stops → ${r.focus}` : r.reason,
  run: async (ctx: AthenaStudentCtx, input: Input): Promise<Result> => {
    // Every candidate node comes from THIS section's published, already-open
    // modules, with this student's own mastery on each — the shared loader the
    // study-focus ranker reads, so a stop's mastery figure and the colour the
    // roadmap paints on the same card cannot disagree.
    const { nodes, journeys } = await buildNodeJourneys(ctx.adminDb, ctx.sectionId, ctx.userId)
    if (nodes.length === 0) {
      return {
        mapped: false,
        reason:
          "this course's roadmap has no open material to build a path from yet — answer the question in prose instead.",
      }
    }

    // The professor's own prerequisite links, scoped to this section. `from` must
    // be understood before `to` (the roadmap draws "do this first —" on `to`).
    const { data: edgeRows, error: edgeError } = await ctx.adminDb
      .from('roadmap_edges')
      .select('from_node_type, from_node_id, to_node_type, to_node_id')
      .eq('section_id', ctx.sectionId)
      .eq('edge_type', 'prerequisite')
      .limit(MAX_EDGES)
    if (edgeError) {
      // Ordering is an enhancement, not the feature — a failed edge read costs
      // the topological sort, not the path.
      logger.warn('map_knowledge_path: prerequisite edges unavailable', {
        source: 'knowledgeMap.run',
        sectionId: ctx.sectionId,
      })
    }
    const prerequisiteEdges: PrereqEdge[] = ((edgeRows ?? []) as Array<{
      from_node_type: string
      from_node_id: string
      to_node_type: string
      to_node_id: string
    }>).map((e) => ({
      from: edgeKey(e.from_node_type, e.from_node_id),
      to: edgeKey(e.to_node_type, e.to_node_id),
    }))

    const resolved = resolveKnowledgePath({
      question: input.question,
      concepts: input.concepts,
      nodes,
      prerequisiteEdges,
    })

    // Honest failure, not improvisation (G1/G2) — but a self-correcting one. Both
    // branches say what missed AND hand back the course's real names, so the model
    // can retry once with wording that exists rather than guess a second time.
    const candidates = courseVocabulary(nodes)
    const retry =
      'Retry ONCE using names from `candidates` verbatim; if that also fails, answer in prose and do not claim you mapped anything.'
    if (!resolved.focus) {
      return {
        mapped: false,
        reason: `nothing on this student's roadmap matches the concept in "${input.question}", so there is no destination to draw a path to — nothing was saved. \`candidates\` lists what this course actually calls its material; if one of them IS what they asked about, re-ask the question using that name. ${retry}`,
        candidates,
      }
    }
    if (resolved.stops.length < MIN_STOPS) {
      const missed = resolved.unmatched.length > 0 ? ` (no match for: ${resolved.unmatched.join(', ')})` : ''
      return {
        mapped: false,
        reason: `only ${resolved.stops.length} of your ${input.concepts.length} proposed concepts match real material on this course's roadmap${missed} — nothing was saved. \`candidates\` lists every name this course's material answers to. ${retry}`,
        candidates,
      }
    }

    const stops = resolved.stops.map((s) => ({
      ...s,
      // A snapshot of where they stood when they asked, not a live figure.
      masteryPct: journeys[s.nodeKey]?.pct ?? null,
    }))
    const payload: KnowledgeMapPayload = {
      question: input.question,
      stops,
      focus: resolved.focus,
    }

    // Anchored to the focus node's own module: the path is ABOUT that concept, so
    // its note belongs in that week's band. Server-resolved, like every anchor.
    const focusModuleId = nodes.find((n) => n.key === resolved.focus?.nodeKey)?.moduleId
    if (!focusModuleId) return { mapped: false, reason: 'could not place the path on a module — try once more' }

    const title = `Path to ${resolved.focus.title}`.slice(0, 120)
    const saved = await saveArtifact(ctx, { moduleId: focusModuleId, kind: 'knowledge_map', title, payload })
    if ('problem' in saved) return { mapped: false, reason: saved.problem }

    // The drive: the ordinary propose channel at the typed route, carrying the
    // row id the insert just returned. The model never sees it, and the roadmap
    // reads the path from the row rather than from anything in the URL beyond it.
    ctx.emit({
      type: 'goto_page',
      route: studentRoute.roadmapPath(ctx.sectionId, saved.id),
      label: `Roadmap · ${ARTIFACT_KIND_META.knowledge_map.label}`,
      said: `Lit the ${stops.length}-stop path to ${resolved.focus.title} on your roadmap — ✕ on the map clears it.`,
    })

    return {
      mapped: true,
      focus: resolved.focus.title,
      stops: stops.map((s) => ({ material: s.title, why: s.why, masteryPercent: s.masteryPct })),
      // Said to the model, not the student: the payload IS the answer, and a
      // paraphrase that renames a stop breaks the link to what they're looking at.
      note: 'List these stops in order with their why lines, naming each material EXACTLY as given. Mention where their mastery is low. Do not add a stop that is not here.',
    }
  },
})
