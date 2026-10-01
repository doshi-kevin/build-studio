// The contract's whole job is to stop being a convention. Two invariants are
// worth a test because both are silent failures otherwise:
//
//   1. A tool input that can carry an identifier is prompt-reachable IDOR — the
//      model would be choosing which row to read, and under N5, to write to.
//      The guard has to reject a plain string, and it has to see through
//      .optional()/.default() wrappers rather than being fooled by them.
//   2. Every shipped tool must actually satisfy that guard. `defineStudentTool`
//      throws at module load, so importing STUDENT_TOOLS is itself the check —
//      but asserting it here names the failure instead of surfacing it as an
//      unrelated suite blowing up on import.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  assertBoundedInput,
  assertNoIdentifierFields,
  buildStudentTools,
  createDirectiveChannel,
  defineStudentTool,
} from '@/lib/ai/student-tutor/contract'
import { STUDENT_TOOLS, studentToolsFor } from '@/lib/ai/student-tutor/tools'

const ok = { name: 'x', kind: 'read' as const, description: 'd', label: 'L', describe: () => '' }

describe('defineStudentTool — no identifiers in input', () => {
  it('rejects a free string field, which is the shape every id arrives in', () => {
    expect(() =>
      defineStudentTool({ ...ok, input: z.object({ quizId: z.string() }), run: async () => null }),
    ).toThrow(/quizId/)
  })

  it('rejects a string hidden behind .optional()', () => {
    expect(() =>
      defineStudentTool({
        ...ok,
        input: z.object({ nodeKey: z.string().optional() }),
        run: async () => null,
      }),
    ).toThrow(/nodeKey/)
  })

  it('accepts the bounded kinds — a closed enum is how horizon-style input is meant to arrive', () => {
    expect(() =>
      defineStudentTool({
        ...ok,
        input: z.object({
          horizon: z.enum(['today', 'this_week']),
          includeMastered: z.boolean().default(false),
        }),
        run: async () => null,
      }),
    ).not.toThrow()
  })

  it('holds for every non-create tool actually shipped', () => {
    // Scoped to read/propose because that is exactly where the contract applies
    // it. A `create` tool's content is model-authored prose by nature, so it
    // trades this rule for the no-identifier-fields rule instead.
    const bounded = STUDENT_TOOLS.filter((t) => t.kind !== 'create')
    expect(bounded.length).toBeGreaterThan(0)
    for (const def of bounded) {
      // The invariant is "bounded", not "empty" — the study-focus `horizon` enum
      // is meant to arrive one day, and asserting emptiness would fail that
      // legitimate change while telling us nothing about the guard.
      expect(() => assertBoundedInput(def.name, def.input)).not.toThrow()
    }
  })

  it('requires a propose tool to declare the plan the student will read', () => {
    // §13.4: a drive that renders no card looks like the app moving on its own.
    expect(() =>
      defineStudentTool({ ...ok, kind: 'propose', input: z.object({}), run: async () => null }),
    ).toThrow(/must declare its steps/)
  })
})

// A `create` tool trades the bounded-input rule away: its content is prose the
// model writes, so `z.string()` can no longer be rejected on TYPE. All that is
// left is the field NAME — which makes this guard the entire load-time defence
// on Athena's only write path, and its blind spots real ones.
describe('defineStudentTool — create tools, where only the field name is left', () => {
  const content = {
    name: 'leave_thing',
    kind: 'create' as const,
    description: 'd',
    label: 'L',
    describe: () => '',
  }

  it('lets a create tool carry free prose that a read tool could never accept', () => {
    // The trade itself: same schema, opposite verdicts. If this ever throws, the
    // kind routing has collapsed back onto assertBoundedInput.
    const input = z.object({ title: z.string().max(120), module: z.string() })
    expect(() => defineStudentTool({ ...content, input, run: async () => null })).not.toThrow()
    expect(() =>
      defineStudentTool({ ...content, kind: 'read', input, run: async () => null }),
    ).toThrow()
  })

  it('rejects an identifier however it is spelled, since the type check is gone', () => {
    // camelCase is how every id in this codebase is actually written — a guard
    // that only reads snake_case would wave through the exact field name the
    // read-tool tests above treat as the canonical IDOR shape.
    for (const field of ['module_id', 'moduleId', 'nodeKey', 'sourceUrl']) {
      expect(() =>
        defineStudentTool({
          ...content,
          input: z.object({ [field]: z.string() }),
          run: async () => null,
        }),
      ).toThrow(new RegExp(field))
    }
  })

  it('finds one buried in an array of objects, which is where content actually lives', () => {
    // The payload is `cards: [{ front, back }]`. A model-supplied reference
    // hides one level down, not at the top — a non-recursive walk sees nothing.
    expect(() =>
      defineStudentTool({
        ...content,
        input: z.object({
          cards: z.array(z.object({ front: z.string(), sourceId: z.string() })).optional(),
        }),
        run: async () => null,
      }),
    ).toThrow(/cards\.\[\]\.sourceId/)
  })

  it("rejects an identifier inside the knowledge map's own concept shape", () => {
    // `map_knowledge_path` ships `concepts: [{ title, why }]`. The one thing that
    // would turn it from "the model names concepts" into "the model names rows"
    // is a key field appearing next to them — and the guard is the only thing
    // between those two, since the tool's node keys are what it writes to a row.
    expect(() =>
      defineStudentTool({
        ...content,
        input: z.object({
          question: z.string(),
          concepts: z.array(z.object({ title: z.string(), why: z.string(), nodeKey: z.string() })),
        }),
        run: async () => null,
      }),
    ).toThrow(/concepts\.\[\]\.nodeKey/)
  })

  it('holds for the shipped create tools, and keeps the ROADMAP writers out of chat mode', () => {
    const copilot = studentToolsFor('copilot')
    const chat = studentToolsFor('chat')
    const creating = copilot.filter((t) => t.kind === 'create')

    // Every writer is registered — a `create` tool that never reaches the model
    // is a feature that silently doesn't exist.
    expect(creating.map((t) => t.name).sort()).toEqual([
      'leave_study_artifact',
      'map_knowledge_path',
      'remember_preference',
    ])
    for (const def of creating) expect(() => assertNoIdentifierFields(def.name, def.input)).not.toThrow()

    // Drive mode is the autonomy switch, and what it governs is the ROADMAP: a
    // student who asked Athena not to touch the app must not find things on it
    // anyway. `remember_preference` is a create tool by input shape only — it
    // writes to that student's own memory, drives nothing, and so ships in both
    // modes. Gating on the `create` KIND would have silently withheld memory
    // from every chat-only student.
    const roadmapWriters = ['leave_study_artifact', 'map_knowledge_path']
    expect(chat.some((t) => roadmapWriters.includes(t.name))).toBe(false)
    expect(chat.some((t) => t.name === 'remember_preference')).toBe(true)
    expect(chat).toHaveLength(copilot.length - roadmapWriters.length)
  })
})

describe('the directive channel', () => {
  it('resolves nothing when no tool asked the app to move', () => {
    expect(createDirectiveChannel().resolve()).toBeNull()
  })

  it('keeps one directive per answer — a later emit replaces an equal-ranked earlier one', () => {
    const channel = createDirectiveChannel()
    channel.emit({ type: 'goto_node', nodeKey: 'a', title: 'A' })
    channel.emit({ type: 'goto_node', nodeKey: 'b', title: 'B' })
    expect(channel.resolve()).toEqual({ type: 'goto_node', nodeKey: 'b', title: 'B' })
  })

  // A turn can run several tools (MAX_TUTOR_STEPS is 4), so "she told me what to
  // study AND booked me in" is a normal turn, not a corner case. Whichever way
  // the two emits land, the proposal has to be the one that survives: the student
  // asked her to set something up, and the roadmap is where the draft she just
  // wrote goes to die — the prefill is written by the client from the proposal,
  // so losing the directive silently discards the note as well as the drive.
  const PROPOSAL = { type: 'goto_page' as const, route: '/student/office-hours', label: 'Office hours', said: 'x' }
  const NAVIGATION = { type: 'goto_node' as const, nodeKey: 'module_item:x', title: 'Attention' }

  it('lets a proposal outrank a plain navigation emitted before it', () => {
    const channel = createDirectiveChannel()
    channel.emit(NAVIGATION)
    channel.emit(PROPOSAL)
    expect(channel.resolve()).toEqual(PROPOSAL)
  })

  it('keeps the proposal even when the navigation is emitted last', () => {
    // The half the ordering test above cannot see: pass here by luck and the
    // student lands on the roadmap with a drafted note nowhere.
    const channel = createDirectiveChannel()
    channel.emit(PROPOSAL)
    channel.emit(NAVIGATION)
    expect(channel.resolve()).toEqual(PROPOSAL)
  })
})

describe('buildStudentTools — run reporting', () => {
  it('closes the row it opened even when the tool throws, so the card cannot spin forever', async () => {
    const events: string[] = []
    const boom = defineStudentTool({
      ...ok,
      name: 'boom',
      input: z.object({}),
      run: async (): Promise<null> => {
        throw new Error('db down')
      },
    })
    const tools = buildStudentTools(
      { adminDb: {}, sectionId: 's', userId: 'u', institutionId: 'i', conversationId: null, emit: () => {} },
      [boom],
      (e) => events.push(e.phase),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any

    await expect(tools.boom.execute({}, {})).rejects.toThrow('db down')
    expect(events).toEqual(['start', 'done'])
  })

  it('refuses a step the definition never declared, so the card cannot drift from the code', async () => {
    // The plan card is a record of what ran. A tool reporting an undeclared step
    // — a renamed id, a copied block — would show the student a plan nobody
    // wrote, so this fails loudly instead of rendering an unlabelled row.
    const drifted = defineStudentTool({
      ...ok,
      name: 'drifted',
      kind: 'propose',
      steps: [{ id: 'declared', label: 'The one real step' }],
      input: z.object({}),
      run: async (_ctx, _input, plan): Promise<null> => plan.step('typo', async () => null),
    })
    const tools = buildStudentTools(
      { adminDb: {}, sectionId: 's', userId: 'u', institutionId: 'i', conversationId: null, emit: () => {} },
      [drifted],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any

    await expect(tools.drifted.execute({}, {})).rejects.toThrow(/never declared/)
  })
})
