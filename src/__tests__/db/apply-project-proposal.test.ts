/**
 * apply_project_proposal, against real Postgres.
 *
 * This function is the SOLE enforcement point for three things, none of which any
 * other test reaches: the tenant check, the idempotency ledger, and the freeze
 * re-read that happens INSIDE the transaction. The adapter next door is a pure
 * function that can only describe a proposal; everything that actually protects a
 * student's saved score lives here, in SQL.
 *
 * Atomicity in particular has to be tested at this layer. "All or nothing" is the
 * premise the whole staged-proposal design rests on, and it cannot be observed from
 * TypeScript — you have to abort a real transaction and look at what survived.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { Client } from 'pg'
import { dbEnv } from './env'
import { FIXTURE, seedFixture } from './fixture'

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: dbEnv().pgUrl })
  await client.connect()
  try {
    const res = await client.query(sql, params)
    return res.rows as T[]
  } finally {
    await client.end()
  }
}

const A = FIXTURE.a
const B = FIXTURE.b

/** Call the function the way the server action does, after its own authz. */
async function apply(proposalId: string, actions: unknown[], over: Partial<{
  projectId: string; sectionId: string; institutionId: string; userId: string
}> = {}) {
  const rows = await query<{ r: Record<string, unknown> }>(
    'select public.apply_project_proposal($1,$2,$3,$4,$5,$6) as r',
    [
      proposalId,
      over.projectId ?? A.project,
      over.sectionId ?? A.section,
      over.institutionId ?? A.institution,
      over.userId ?? A.users.professor.id,
      JSON.stringify(actions),
    ],
  )
  return rows[0].r
}

const phaseCount = async (projectId = A.project) =>
  Number((await query<{ n: string }>('select count(*) n from project_master_phases where project_id=$1', [projectId]))[0].n)

const itemCount = async (projectId = A.project) =>
  Number((await query<{ n: string }>('select count(*) n from project_phase_items where project_id=$1', [projectId]))[0].n)

const PHASE = (key: string, name: string) => ({ kind: 'addPhase', key, name, startDate: null, endDate: null })
const ROW = (phaseRef: string, title: string, weight = 10) => ({
  kind: 'addItem', phaseRef, itemType: 'manual', title, weight, grain: 'team', scoringMode: 'numeric',
})

describe('apply_project_proposal', () => {
  beforeAll(async () => {
    await seedFixture()
  })

  afterEach(async () => {
    // The fixture's own phase is seeded by uuid, so only clear what these tests add.
    await query("delete from project_item_scores where project_id in ($1,$2)", [A.project, B.project])
    await query("delete from project_master_phases where project_id in ($1,$2) and name like 'RLSTEST %'", [A.project, B.project])
    await query('delete from project_proposal_applications')
  })

  it('refuses a project whose institution is not the caller`s verified one', async () => {
    // Tenant A's project id, tenant B's institution. The section/institution pair is
    // what the server action verified, so this is the IDOR boundary.
    const before = await phaseCount()
    const res = await apply('11111111-1111-4111-8111-111111111111', [PHASE('p1', 'RLSTEST Leak')], {
      institutionId: B.institution,
    })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('could not be found')
    expect(await phaseCount()).toBe(before)
  })

  it('refuses a project that belongs to another section', async () => {
    const before = await phaseCount(B.project)
    const res = await apply('22222222-2222-4222-8222-222222222222', [PHASE('p1', 'RLSTEST Cross')], {
      projectId: B.project, // B's project, but A's section + institution
    })
    expect(res.ok).toBe(false)
    expect(await phaseCount(B.project)).toBe(before)
  })

  it('is idempotent: the same proposal id twice writes one board, not two', async () => {
    const id = '33333333-3333-4333-8333-333333333333'
    const actions = [PHASE('p1', 'RLSTEST Once'), ROW('newPhase:p1', 'RLSTEST Row')]

    const first = await apply(id, actions)
    expect(first.ok).toBe(true)
    expect(first.alreadyApplied).toBe(false)
    expect(Number(first.phasesAdded)).toBe(1)

    const second = await apply(id, actions)
    expect(second.alreadyApplied).toBe(true)
    expect(Number(second.phasesAdded)).toBe(0)

    const named = await query<{ n: string }>(
      "select count(*) n from project_master_phases where project_id=$1 and name='RLSTEST Once'", [A.project])
    expect(Number(named[0].n)).toBe(1)
  })

  it('ATOMICITY: a batch that raises part-way leaves nothing behind', async () => {
    // The second action references a phase key that was never added. The first
    // action has ALREADY inserted by then, so if this is not one transaction its
    // phase survives — which is exactly the half-built board the design forbids.
    const before = await phaseCount()
    await expect(
      apply('44444444-4444-4444-8444-444444444444', [
        PHASE('good', 'RLSTEST Atomic'),
        ROW('newPhase:never-added', 'RLSTEST Orphan'),
      ]),
    ).rejects.toThrow()
    expect(await phaseCount()).toBe(before)

    // And the idempotency claim must not survive the rollback, or the professor
    // could never retry that proposal.
    const claims = await query<{ n: string }>(
      'select count(*) n from project_proposal_applications where proposal_id=$1',
      ['44444444-4444-4444-8444-444444444444'])
    expect(Number(claims[0].n)).toBe(0)
  })

  it('refuses a duplicate phase key rather than mis-filing the row', async () => {
    // `jsonb ||` is last-write-wins, so a repeated key silently re-points an earlier
    // phase and sends a row to the wrong one — no error, invisible in review. The
    // adapter mints unique keys, but that protects exactly one caller.
    const before = await phaseCount()
    await expect(
      apply('55555555-5555-4555-8555-555555555555', [
        PHASE('p1', 'RLSTEST First'),
        PHASE('p1', 'RLSTEST Second'),
        ROW('newPhase:p1', 'RLSTEST Ambiguous'),
      ]),
    ).rejects.toThrow(/reused the phase key/)
    expect(await phaseCount()).toBe(before)
  })

  it('FREEZE: refuses to delete a rubric row once a score exists, and the score survives', async () => {
    // Build a board, score it, then try to remove the scored row.
    await apply('66666666-6666-4666-8666-666666666666', [
      PHASE('p1', 'RLSTEST Frozen'),
      ROW('newPhase:p1', 'RLSTEST Scored row'),
    ])
    const item = await query<{ id: string; institution_id: string }>(
      "select id, institution_id from project_phase_items where project_id=$1 and manual_title='RLSTEST Scored row'",
      [A.project])
    expect(item.length).toBe(1)

    await query(
      'insert into project_item_scores (phase_item_id, project_id, institution_id, team_id, earned) values ($1,$2,$3,$4,5)',
      [item[0].id, A.project, item[0].institution_id, A.team])

    const itemsBefore = await itemCount()
    await expect(
      apply('77777777-7777-4777-8777-777777777777', [{ kind: 'removeItem', itemId: item[0].id }]),
    ).rejects.toThrow(/FROZEN/)

    // The row and its score both survive: this is the whole point of the in-transaction re-read.
    expect(await itemCount()).toBe(itemsBefore)
    const scores = await query<{ n: string }>(
      'select count(*) n from project_item_scores where phase_item_id=$1', [item[0].id])
    expect(Number(scores[0].n)).toBe(1)
  })

  it('refuses a rubric row pointing at work outside this course', async () => {
    // The one id not otherwise bound to the caller's scope. A foreign key proves the
    // assignment exists SOMEWHERE, not that it is this course's — so without this a
    // staff member could surface another institution's assignment title, points and
    // due date on their own board, and to their own students.
    const foreign = await query<{ id: string }>(
      'select id from assignments where section_id = $1 limit 1', [B.section])
    const before = await itemCount()
    await apply('aaaaaaaa-0000-4000-8000-00000000aaaa', [PHASE('p1', 'RLSTEST Foreign')])
    const phase = await query<{ id: string }>(
      "select id from project_master_phases where project_id=$1 and name='RLSTEST Foreign'", [A.project])

    if (foreign.length) {
      await expect(
        apply('bbbbbbbb-0000-4000-8000-00000000bbbb', [{
          kind: 'addItem', phaseRef: phase[0].id, itemType: 'assignment',
          sourceId: foreign[0].id, title: 'RLSTEST Leaked', weight: 10,
          grain: 'individual', scoringMode: 'numeric',
        }]),
      ).rejects.toThrow(/outside this course/)
      expect(await itemCount()).toBe(before)
    }
  })

  it('FREEZE is additive-friendly: a new row still lands on a scored project', async () => {
    await apply('88888888-8888-4888-8888-888888888888', [
      PHASE('p1', 'RLSTEST Additive'),
      ROW('newPhase:p1', 'RLSTEST Base row'),
    ])
    const item = await query<{ id: string; institution_id: string }>(
      "select id, institution_id from project_phase_items where project_id=$1 and manual_title='RLSTEST Base row'",
      [A.project])
    await query(
      'insert into project_item_scores (phase_item_id, project_id, institution_id, team_id, earned) values ($1,$2,$3,$4,5)',
      [item[0].id, A.project, item[0].institution_id, A.team])

    const phase = await query<{ id: string }>(
      "select id from project_master_phases where project_id=$1 and name='RLSTEST Additive'", [A.project])
    const res = await apply('99999999-9999-4999-8999-999999999999', [
      ROW(phase[0].id, 'RLSTEST Added while frozen', 5),
    ])
    expect(res.ok).toBe(true)
    expect(Number(res.itemsAdded)).toBe(1)
  })
})
