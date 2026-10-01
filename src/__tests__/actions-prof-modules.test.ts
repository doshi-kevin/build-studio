// Tenant/section-isolation tests for professor module-item actions
// (security review Vulns 2/3/11/12). Each mutator must verify the module
// (and thus the item) belongs to the verified section before touching it,
// so an owner of one section cannot mutate another section's module items.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockAdminClient, createTableRouter, buildFullChain } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockEmitEvent = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({
  emitEvent: (...args: unknown[]) => mockEmitEvent(...args),
  markFeedItemDone: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
// Heavy server-only modules imported by the actions file — stub so the module
// graph loads under vitest. The section-bind check runs before any of these.
vi.mock('@/lib/extraction/enqueue', () => ({
  enqueueExtractionJob: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
}))
vi.mock('@/lib/document-parser', () => ({
  parseDocument: vi.fn(),
  downloadFileBuffer: vi.fn(),
  getTextForLLM: vi.fn(),
}))
vi.mock('@/lib/document-parser/utils', () => ({
  isSupportedFileType: vi.fn().mockReturnValue(true),
  MAX_EXTRACTION_SIZE: 10_000_000,
}))
vi.mock('@/lib/ai/llm-client', () => ({ extractTopicsFromContent: vi.fn() }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockAdminClient.mockReset()
  mockEmitEvent.mockReset()
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/modules/actions')
})

/** Caller owns the section; the module lookup result decides cross/same-section. */
function setup(moduleResult: { data: unknown; error: unknown }, extra: Record<string, { data: unknown; error: unknown }> = {}) {
  const client = createMockAdminClient({
    course_sections: { data: { id: 'sec-A', professor_id: 'prof-1' }, error: null },
    modules: moduleResult,
    ...extra,
  })
  mockAdminClient.mockReturnValue(client)
  return client
}

describe('updateModuleItem — section isolation', () => {
  it('rejects when the module is not in the verified section and never writes', async () => {
    const client = setup({ data: null, error: null }) // module not in section
    const res = await mod.updateModuleItem('item-X', 'mod-X', 'sec-A', { title: 'Hijack' })
    expect(res).toEqual({ error: 'Module not found' })
    expect(client._tableCalls).not.toContain('module_items')
  })

  it('allows updating an item whose module is in the section', async () => {
    // Full-chain router so the module_items .update().eq().eq() resolves.
    mockAdminClient.mockReturnValue(createTableRouter({
      course_sections: buildFullChain({ data: { id: 'sec-A', professor_id: 'prof-1' }, error: null }),
      modules: buildFullChain({ data: { id: 'mod-A' }, error: null }),
      module_items: buildFullChain({ data: null, error: null }),
    }))
    const res = await mod.updateModuleItem('item-A', 'mod-A', 'sec-A', { title: 'Updated' })
    expect(res).toEqual({ success: true })
  })
})

describe('deleteModuleItem — section isolation', () => {
  it('rejects when the module is not in the verified section and never deletes', async () => {
    const client = setup({ data: null, error: null })
    const res = await mod.deleteModuleItem('item-X', 'mod-X', 'sec-A')
    expect(res).toEqual({ error: 'Module not found' })
    expect(client._tableCalls).not.toContain('module_items')
  })
})

describe('reorderModuleItems — section isolation', () => {
  it('rejects when the module is not in the verified section and never reorders', async () => {
    const client = setup({ data: null, error: null })
    const res = await mod.reorderModuleItems('mod-X', 'sec-A', ['item-X'])
    expect(res).toEqual({ error: 'Module not found' })
    expect(client._tableCalls).not.toContain('module_items')
  })
})

describe('extractDocumentContent — section isolation', () => {
  it('rejects an item whose module is not in the verified section', async () => {
    // The modules!inner(section_id) join filter yields no row cross-section.
    setup({ data: null, error: null }, { module_items: { data: null, error: null } })
    const res = await mod.extractDocumentContent('item-X', 'sec-A')
    expect(res).toEqual({ error: 'Module item not found' })
  })
})

describe('enqueueExtractionJobAction — section isolation', () => {
  it('rejects an item whose module is not in the verified section', async () => {
    setup({ data: null, error: null }, { module_items: { data: null, error: null } })
    const res = await mod.enqueueExtractionJobAction('item-X', 'sec-A')
    expect(res).toEqual({ error: 'Module item not found' })
  })
})

// moveModuleItem takes THREE client-supplied ids (item + source module + target module),
// so it needs its own section bind on both modules — `.in()` happily returns just one row
// when the other module belongs to somebody else's section. It also renumbers positions in
// both modules, which is the off-by-one-prone part of the drag gesture.
describe('moveModuleItem', () => {
  /**
   * module_items is queried several times with different shapes, so hand out a fresh
   * chain per `.from()` and resolve them in call order:
   *   1 item lookup (.single) → 2 target list → 3 move update → 4 source list → 5+ renumbers
   */
  function mockMove(opts: {
    modulesInSection: { id: string }[]
    item?: { id: string } | null
    targetItems?: { id: string }[]
    sourceItems?: { id: string }[]
  }) {
    const itemChains: ReturnType<typeof buildFullChain>[] = []
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'course_sections') {
          return buildFullChain({ data: { id: 'sec-A', professor_id: 'prof-1' }, error: null })
        }
        if (table === 'modules') {
          return buildFullChain({ data: opts.modulesInSection, error: null })
        }
        const call = itemChains.length + 1
        const result =
          call === 1 ? { data: opts.item ?? null, error: null }
          : call === 2 ? { data: opts.targetItems ?? [], error: null }
          : call === 4 ? { data: opts.sourceItems ?? [], error: null }
          : { data: null, error: null }
        const chain = buildFullChain(result)
        itemChains.push(chain)
        return chain
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    return { admin, itemChains }
  }

  /** The (id, position, module_id) triples the renumber pass actually wrote. */
  function renumberWrites(itemChains: ReturnType<typeof buildFullChain>[]) {
    return itemChains.slice(4).map((chain) => ({
      id: chain.eq.mock.calls[0][1],
      position: (chain.update.mock.calls[0][0] as { position: number }).position,
      moduleId: chain.eq.mock.calls[1][1],
    }))
  }

  it('rejects when the target module belongs to another section and never touches items', async () => {
    // `.in([mod-A, mod-B])` scoped to sec-A matches only the source module.
    const { admin, itemChains } = mockMove({ modulesInSection: [{ id: 'mod-A' }] })
    const res = await mod.moveModuleItem('item-1', 'mod-A', 'mod-B', 'sec-A', 0)
    expect(res).toEqual({ error: 'Module not found' })
    expect(admin.from.mock.calls.map((c) => c[0])).not.toContain('module_items')
    expect(itemChains).toHaveLength(0)
  })

  it('rejects when the item does not live in the source module and writes nothing', async () => {
    const { itemChains } = mockMove({
      modulesInSection: [{ id: 'mod-A' }, { id: 'mod-B' }],
      item: null, // .eq('module_id', fromModuleId) matched no row
    })
    const res = await mod.moveModuleItem('item-X', 'mod-A', 'mod-B', 'sec-A', 0)
    expect(res).toEqual({ error: 'Item not found' })
    expect(itemChains).toHaveLength(1) // only the lookup happened
    expect(itemChains[0].update).not.toHaveBeenCalled()
  })

  it('rejects a same-module move before touching the database', async () => {
    const { admin } = mockMove({ modulesInSection: [{ id: 'mod-A' }] })
    const res = await mod.moveModuleItem('item-1', 'mod-A', 'mod-A', 'sec-A', 0)
    expect(res).toEqual({ error: 'Item is already in this module' })
    expect(admin.from.mock.calls.map((c) => c[0])).toEqual(['course_sections'])
  })

  it('inserts at toIndex and renumbers both modules densely', async () => {
    const { itemChains } = mockMove({
      modulesInSection: [{ id: 'mod-A' }, { id: 'mod-B' }],
      item: { id: 'item-2' },
      targetItems: [{ id: 'b-1' }, { id: 'b-2' }], // read before the move
      sourceItems: [{ id: 'item-1' }, { id: 'item-3' }], // read after it
    })

    const res = await mod.moveModuleItem('item-2', 'mod-A', 'mod-B', 'sec-A', 1)

    expect(res).toEqual({ success: true })
    expect(renumberWrites(itemChains)).toEqual([
      { id: 'b-1', position: 0, moduleId: 'mod-B' },
      { id: 'item-2', position: 1, moduleId: 'mod-B' },
      { id: 'b-2', position: 2, moduleId: 'mod-B' },
      // source closes the gap the moved item left behind
      { id: 'item-1', position: 0, moduleId: 'mod-A' },
      { id: 'item-3', position: 1, moduleId: 'mod-A' },
    ])
  })

  // toIndex is client-supplied, so it can arrive out of range from a stale board.
  // A negative index is the dangerous one: Array.splice treats it as an offset from
  // the END, which would silently drop the item into the wrong slot without the clamp.
  it.each([
    { toIndex: 99, expected: ['b-1', 'b-2', 'item-2'], label: 'past the end → appended' },
    { toIndex: -1, expected: ['item-2', 'b-1', 'b-2'], label: 'negative → first, not offset from the end' },
  ])('clamps an out-of-range toIndex ($label)', async ({ toIndex, expected }) => {
    const { itemChains } = mockMove({
      modulesInSection: [{ id: 'mod-A' }, { id: 'mod-B' }],
      item: { id: 'item-2' },
      targetItems: [{ id: 'b-1' }, { id: 'b-2' }],
      sourceItems: [],
    })

    const res = await mod.moveModuleItem('item-2', 'mod-A', 'mod-B', 'sec-A', toIndex)

    expect(res).toEqual({ success: true })
    expect(renumberWrites(itemChains).map((w) => w.id)).toEqual(expected)
  })
})

// The professor's notify-vs-silent choice when publishing a module. `notify` is a transient
// control (never persisted); publishing notifies enrolled students unless notify === false.
describe('updateModule — publish notify gate', () => {
  // "Open to students" is BOTH halves — published AND past its unlock date — so each case
  // below pins the module's open-ness on either side of the save.
  const CLOSED = { is_published: false, unlock_date: null } // a draft / unpublished
  const OPEN = { is_published: true, unlock_date: null } // live and visible right now

  /** `after` is what the UPDATE returns (the state students get); `before` is what the
   *  pre-write read returns. updateModule compares the two, so the notice fires on the
   *  transition closed → open rather than on any edit that happens to touch the row. */
  function publishSetup(
    after: Record<string, unknown> = {},
    before: Record<string, unknown> = CLOSED,
  ) {
    const modules = buildFullChain({
      data: { title: 'Week 3', week_number: 3, ...OPEN, ...after },
      error: null,
    })
    // The pre-write read resolves first; the UPDATE's returning row falls through to the
    // chain's default, so one chain can answer both reads with different rows.
    modules.maybeSingle.mockResolvedValueOnce({ data: before, error: null })
    mockAdminClient.mockReturnValue(
      createTableRouter({
        course_sections: buildFullChain({ data: { id: 'sec-A', professor_id: 'prof-1' }, error: null }),
        modules,
      }),
    )
  }

  it('notifies on a publish transition and re-announces via refresh (so republish re-notifies)', async () => {
    publishSetup({}, CLOSED) // currently a draft / unpublished — publishing opens it
    const res = await mod.updateModule('mod-A', 'sec-A', { is_published: true })
    expect(res).toEqual({ success: true })
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent.mock.calls[0][0]).toMatchObject({
      type: 'module_published',
      sectionId: 'sec-A',
      entity: { type: 'module', id: 'mod-A' },
      // refresh re-surfaces the notice past the one-shot dedup on unpublish → republish
      onDuplicate: 'refresh',
    })
  })

  it('publishes silently when notify is false — no notification emitted', async () => {
    publishSetup({}, CLOSED)
    const res = await mod.updateModule('mod-A', 'sec-A', { is_published: true, notify: false })
    expect(res).toEqual({ success: true })
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  /* The reason the gate reads the BEFORE state rather than trusting the payload: the edit
     form re-submits is_published: true on every save of a live module. Without the
     transition check, `onDuplicate: 'refresh'` above would re-announce on each one. */
  it('does not re-notify when re-saving an already-open module (no transition)', async () => {
    publishSetup({}, OPEN) // already published and open — this save is just an edit
    const res = await mod.updateModule('mod-A', 'sec-A', { is_published: true })
    expect(res).toEqual({ success: true })
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  /* "New module" that deep-links to a week the student can't open yet is a broken
     promise, so publishing behind a future unlock_date stays silent — and the edit
     that actually opens it carries the notice instead. */
  it('stays silent when publishing a module that is not open yet', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    publishSetup({ unlock_date: future }, CLOSED)
    const res = await mod.updateModule('mod-A', 'sec-A', { is_published: true, unlock_date: future })
    expect(res).toEqual({ success: true })
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  // The row's "Open to students now" — clearing the date is what opens the module, so that
  // edit is the one students hear about, even though is_published never changed.
  it('notifies when clearing the unlock date opens an already-published module', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    publishSetup({}, { is_published: true, unlock_date: future }) // published but locked
    const res = await mod.updateModule('mod-A', 'sec-A', { unlock_date: null })
    expect(res).toEqual({ success: true })
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent.mock.calls[0][0]).toMatchObject({
      type: 'module_published',
      entity: { type: 'module', id: 'mod-A' },
    })
  })

  // An unrelated edit (a retitle) must not re-announce a module that was already open.
  it('does not notify on an edit that leaves the open state alone', async () => {
    publishSetup({}, OPEN)
    const res = await mod.updateModule('mod-A', 'sec-A', { title: 'Week 3 — revised' })
    expect(res).toEqual({ success: true })
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  // A garbage date can't reach the timestamptz column.
  it('rejects an unparseable unlock date instead of failing at the DB', async () => {
    publishSetup()
    const res = await mod.updateModule('mod-A', 'sec-A', { unlock_date: 'next tuesday' })
    expect(res.error).toMatch(/valid open date/i)
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })
})

// createModule's notify gate is the same one-liner as updateModule's — cover it too, since
// creating a module already-published is the other path that can notify (or not).
describe('createModule — publish notify gate', () => {
  function createSetup() {
    // Both the position lookup and the insert().select('id').single() resolve here.
    const modules = buildFullChain({ data: { id: 'mod-new' }, error: null })
    mockAdminClient.mockReturnValue(
      createTableRouter({
        course_sections: buildFullChain({ data: { id: 'sec-A', professor_id: 'prof-1' }, error: null }),
        modules,
      }),
    )
    return modules
  }

  it('notifies students when a module is created already published', async () => {
    createSetup()
    const res = await mod.createModule('sec-A', { title: 'Week 1', is_published: true })
    expect(res).toEqual({ success: true, moduleId: 'mod-new' })
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockEmitEvent.mock.calls[0][0]).toMatchObject({
      type: 'module_published',
      sectionId: 'sec-A',
      entity: { type: 'module', id: 'mod-new' },
    })
  })

  it('creates silently when notify is false — no notification emitted', async () => {
    createSetup()
    const res = await mod.createModule('sec-A', { title: 'Week 1', is_published: true, notify: false })
    expect(res).toEqual({ success: true, moduleId: 'mod-new' })
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('does not notify when the module is created as a draft', async () => {
    createSetup()
    const res = await mod.createModule('sec-A', { title: 'Week 1', is_published: false })
    expect(res).toEqual({ success: true, moduleId: 'mod-new' })
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  /* Modules and dividers share ONE position scale (see reorderModules), so the
     append has to measure BOTH tables. Measuring only `modules` put a new module
     on the same position as a divider sitting past the last module, and
     mergeModuleRows breaks that tie in the module's favour — so creating a module
     silently reordered the two, and the roadmap read the new order. */
  it('appends one past the last row of EITHER table', async () => {
    const modules = buildFullChain({ data: [{ position: 2 }], error: null })
    const dividers = buildFullChain({ data: [{ position: 7 }], error: null })
    mockAdminClient.mockReturnValue(createTableRouter({
      course_sections: buildFullChain({ data: { id: 'sec-A', professor_id: 'prof-1' }, error: null }),
      modules,
      module_dividers: dividers,
    }))
    await mod.createModule('sec-A', { title: 'Week 4', is_published: false })
    expect(modules.insert).toHaveBeenCalledWith(expect.objectContaining({ position: 8 }))
  })

  it('starts at 0 in an empty section', async () => {
    const modules = buildFullChain({ data: [], error: null })
    mockAdminClient.mockReturnValue(createTableRouter({
      course_sections: buildFullChain({ data: { id: 'sec-A', professor_id: 'prof-1' }, error: null }),
      modules,
      module_dividers: buildFullChain({ data: [], error: null }),
    }))
    await mod.createModule('sec-A', { title: 'Week 1', is_published: false })
    expect(modules.insert).toHaveBeenCalledWith(expect.objectContaining({ position: 0 }))
  })

  // createModule builds its insert from an EXPLICIT field list (updateModule
  // spreads instead), so a new column is silently dropped on create unless it's
  // added by hand — which is exactly what happened to coverage_state.
  it('persists coverage_state on create, defaulting to active', async () => {
    const modules = createSetup()
    await mod.createModule('sec-A', { title: 'Week 9', is_published: true, coverage_state: 'skipped' })
    expect(modules.insert).toHaveBeenCalledWith(expect.objectContaining({ coverage_state: 'skipped' }))

    const fresh = createSetup()
    await mod.createModule('sec-A', { title: 'Week 1', is_published: true })
    expect(fresh.insert).toHaveBeenCalledWith(expect.objectContaining({ coverage_state: 'active' }))
  })
})

// ── Module-level dividers ────────────────────────────────────────
// A divider is a row on the Modules page with no items and no publish state, so
// ownership + section binding are its ONLY access control. It also shares modules'
// position scale, which is the contract the roadmap reads.
describe('module divider actions', () => {
  const SECTION = { id: 'sec-A', professor_id: 'prof-1', institution_id: 'inst-1' }
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  /** Owner + per-table chains, for the paths that reach a write. */
  function owned(over: Record<string, ReturnType<typeof buildFullChain>> = {}) {
    const dividers = over.module_dividers ?? buildFullChain({ data: [], error: null })
    const modules = over.modules ?? buildFullChain({ data: [], error: null })
    mockAdminClient.mockReturnValue(createTableRouter({
      course_sections: buildFullChain({ data: SECTION, error: null }),
      modules,
      module_dividers: dividers,
    }))
    return { modules, dividers }
  }

  /** Caller is authenticated but owns a DIFFERENT section. */
  function notOwner() {
    const client = createMockAdminClient({
      course_sections: { data: { ...SECTION, professor_id: 'prof-2' }, error: null },
    })
    mockAdminClient.mockReturnValue(client)
    return client
  }

  it('createModuleDivider appends one past the last row of EITHER table', async () => {
    // The shared scale is the whole point: appending past only `modules` would drop
    // the new divider on top of an existing one.
    const { dividers } = owned({
      modules: buildFullChain({ data: [{ position: 2 }], error: null }),
      module_dividers: buildFullChain({ data: [{ position: 4 }], error: null }),
    })
    const res = await mod.createModuleDivider('sec-A', { title: 'Midterm' })
    expect(res).toEqual({ success: true })
    // institution_id is the tenant key on every scoped write.
    expect(dividers.insert).toHaveBeenCalledWith({
      section_id: 'sec-A',
      institution_id: 'inst-1',
      title: 'Midterm',
      position: 5,
    })
  })

  it('createModuleDivider starts at 0 in an empty section', async () => {
    const { dividers } = owned()
    await mod.createModuleDivider('sec-A', { title: 'Unit 1' })
    expect(dividers.insert).toHaveBeenCalledWith(expect.objectContaining({ position: 0 }))
  })

  /* Undo passes the deleted row's own id back so the restored divider IS the old
     row, not a lookalike — ordering is position-driven, so a fresh id looks
     identical on screen while anything keyed on the id (a deep link, an analytics
     event) silently points at a row that no longer exists. */
  it('createModuleDivider restores under the original id when one is given', async () => {
    const { dividers } = owned({ module_dividers: buildFullChain({ data: [{ position: 3 }], error: null }) })
    const res = await mod.createModuleDivider('sec-A', { title: 'Midterm' }, uuid(9))
    expect(res).toEqual({ success: true })
    expect(dividers.insert).toHaveBeenCalledWith(expect.objectContaining({
      id: uuid(9),
      section_id: 'sec-A',
      institution_id: 'inst-1',
      position: 4,
    }))
  })

  it('createModuleDivider omits id entirely on a normal create', async () => {
    const { dividers } = owned()
    await mod.createModuleDivider('sec-A', { title: 'Midterm' })
    // Not `id: undefined` — that would send the key and let Postgres reject it.
    expect(Object.keys(dividers.insert.mock.calls[0][0] as object)).not.toContain('id')
  })

  /* restoreId is client-supplied and lands in an INSERT as the primary key, so it
     is validated like any other external input. institution_id still comes from
     the verified section, and a collision with a live row fails the insert rather
     than overwriting it — but a non-uuid must not reach the statement at all. */
  it('createModuleDivider rejects a malformed restoreId and never writes', async () => {
    const { dividers } = owned()
    const res = await mod.createModuleDivider('sec-A', { title: 'Midterm' }, 'not-a-uuid')
    expect(res).toEqual({ error: 'Invalid divider' })
    expect(dividers.insert).not.toHaveBeenCalled()
  })

  it('createModuleDivider rejects a non-owner and never writes', async () => {
    const client = notOwner()
    const res = await mod.createModuleDivider('sec-A', { title: 'Midterm' })
    expect(res).toEqual({ error: 'You do not own this course section' })
    expect(client._tableCalls).not.toContain('module_dividers')
  })

  it('createModuleDivider rejects a blank label', async () => {
    owned()
    expect(await mod.createModuleDivider('sec-A', { title: '   ' })).toEqual({ error: 'Label is required' })
  })

  it('createModuleDivider rejects an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    expect(await mod.createModuleDivider('sec-A', { title: 'Midterm' })).toEqual({ error: 'Not authenticated' })
  })

  it('updateModuleDivider binds the row to the verified section', async () => {
    const { dividers } = owned()
    const res = await mod.updateModuleDivider(uuid(1), 'sec-A', { title: 'Finals' })
    expect(res).toEqual({ success: true })
    expect(dividers.update).toHaveBeenCalledWith(expect.objectContaining({ title: 'Finals' }))
    // Without the section_id bind, an owner of ANY section could rename any divider.
    expect(dividers.eq).toHaveBeenCalledWith('id', uuid(1))
    expect(dividers.eq).toHaveBeenCalledWith('section_id', 'sec-A')
  })

  it('deleteModuleDivider binds the row to the verified section', async () => {
    const { dividers } = owned()
    const res = await mod.deleteModuleDivider(uuid(1), 'sec-A')
    expect(res).toEqual({ success: true })
    expect(dividers.delete).toHaveBeenCalled()
    expect(dividers.eq).toHaveBeenCalledWith('id', uuid(1))
    expect(dividers.eq).toHaveBeenCalledWith('section_id', 'sec-A')
  })

  it('deleteModuleDivider rejects a non-owner and never writes', async () => {
    const client = notOwner()
    const res = await mod.deleteModuleDivider(uuid(1), 'sec-A')
    expect(res).toEqual({ error: 'You do not own this course section' })
    expect(client._tableCalls).not.toContain('module_dividers')
  })
})

// reorderModules now rewrites TWO tables from one merged list. The 0..n-1 scale it
// writes is what the roadmap sorts modules and dividers together by, so a row sent
// to the wrong table silently moves a break somewhere else on the map.
describe('reorderModules — modules + dividers as one list', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  it('writes each row to its own table with its index in the merged order', async () => {
    const modules = buildFullChain({ data: null, error: null })
    const dividers = buildFullChain({ data: null, error: null })
    mockAdminClient.mockReturnValue(createTableRouter({
      course_sections: buildFullChain({ data: { id: 'sec-A', professor_id: 'prof-1' }, error: null }),
      modules,
      module_dividers: dividers,
    }))

    const res = await mod.reorderModules('sec-A', [
      { id: uuid(1), kind: 'module' },
      { id: uuid(2), kind: 'divider' },
      { id: uuid(3), kind: 'module' },
    ])

    expect(res).toEqual({ success: true })
    expect(modules.update).toHaveBeenCalledTimes(2)
    expect(modules.update.mock.calls[0][0]).toMatchObject({ position: 0 })
    expect(modules.update.mock.calls[1][0]).toMatchObject({ position: 2 })
    expect(dividers.update).toHaveBeenCalledTimes(1)
    expect(dividers.update.mock.calls[0][0]).toMatchObject({ position: 1 })
    // Every write stays inside the verified section.
    expect(dividers.eq).toHaveBeenCalledWith('section_id', 'sec-A')
    expect(modules.eq).toHaveBeenCalledWith('section_id', 'sec-A')
  })

  it('rejects a malformed entry list before any write', async () => {
    const client = setup({ data: null, error: null })
    const res = await mod.reorderModules('sec-A', [{ id: 'not-a-uuid', kind: 'module' }])
    expect(res.error).toBeTruthy()
    expect(client._tableCalls).not.toContain('module_dividers')
    expect(client._tableCalls).not.toContain('modules')
  })

  it('rejects a non-owner and never writes', async () => {
    const client = createMockAdminClient({
      course_sections: { data: { id: 'sec-A', professor_id: 'prof-2' }, error: null },
    })
    mockAdminClient.mockReturnValue(client)
    const res = await mod.reorderModules('sec-A', [{ id: uuid(1), kind: 'divider' }])
    expect(res).toEqual({ error: 'You do not own this course section' })
    expect(client._tableCalls).not.toContain('module_dividers')
  })
})
