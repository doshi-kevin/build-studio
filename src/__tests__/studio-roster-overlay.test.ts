/**
 * The host-drawn RosterTable (roster-overlay.ts), in jsdom: names come from the page's
 * provider and stay there; the plugin hears only handles, column keys and values.
 * Message gating and strikes are tested with the host in studio-runtime-host.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RosterPayload } from '@/lib/studio/runtime/protocol'
import { createRosterOverlay, ROSTER_MAX_SLOTS, UNKNOWN_STUDENT } from '@/lib/studio/runtime/roster-overlay'
import { PREVIEW_ROSTER, previewRosterNames } from '@/lib/studio/runtime/preview-roster'

const [A, B, C] = PREVIEW_ROSTER.map((s) => s.handle)
const UNLISTED = `st_${'9'.repeat(20)}`
const settle = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => document.body.replaceChildren())

function payload(overrides: Partial<RosterPayload> = {}): RosterPayload {
  return {
    label: 'Attendance',
    sort: 'name',
    searchable: true,
    columns: [
      { key: 'status', header: 'Today' },
      { key: 'grade', header: 'Grade' },
      { key: 'nudge', header: 'Reminder' },
    ],
    rows: [A, B, C].map((student) => ({
      student,
      cells: {
        status: { kind: 'choice', value: student === A ? 'present' : null, options: [{ value: 'present', label: 'Present', tone: 'success' }, { value: 'absent', label: 'Absent', tone: 'danger' }] },
        grade: { kind: 'select', value: null, placeholder: 'Grade', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
        nudge: { kind: 'button', label: 'Remind', value: 'remind', variant: 'secondary' },
      },
    })),
    emptyText: 'Nobody here yet.',
    ...overrides,
  }
}

function setup(names: () => Promise<Record<string, string>> = async () => previewRosterNames()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const onAction = vi.fn()
  const overlay = createRosterOverlay({ container, names, onAction })
  const rowNames = () => [...container.querySelectorAll('tbody tr')].filter((tr) => (tr as HTMLElement).style.display !== 'none').map((tr) => tr.querySelector('th')?.textContent)
  return { container, overlay, onAction, rowNames }
}

const nameOf = (handle: string) => PREVIEW_ROSTER.find((s) => s.handle === handle)!.name
const sortedNames = [A, B, C].map(nameOf).sort((x, y) => x.localeCompare(y))

describe('roster overlay', () => {
  it('shows names from the page’s provider, sorted by name, in a labelled table', async () => {
    const { container, overlay, rowNames } = setup()
    overlay.render('r1', payload())
    await settle()
    expect(container.querySelector('table')?.getAttribute('aria-label')).toBe('Attendance')
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Student', 'Today', 'Grade', 'Reminder'])
    expect(rowNames()).toEqual(sortedNames)
  })

  it('keeps the plugin’s order when it asks for it, and says “Unknown student” for a handle without a name', async () => {
    const { overlay, rowNames } = setup()
    overlay.render('r1', payload({ sort: 'given', rows: [C, UNLISTED, A].map((student) => ({ student, cells: {} })) }))
    await settle()
    expect(rowNames()).toEqual([nameOf(C), UNKNOWN_STUDENT, nameOf(A)])
  })

  it('shows a skeleton until names arrive, then the names', async () => {
    let resolve: (names: Record<string, string>) => void = () => {}
    const { container, overlay, rowNames } = setup(() => new Promise((r) => (resolve = r)))
    overlay.render('r1', payload())
    expect(container.querySelector('table')?.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('tbody th')?.textContent).toBe('Loading name')
    resolve(previewRosterNames())
    await settle()
    expect(container.querySelector('table')?.hasAttribute('aria-busy')).toBe(false)
    expect(rowNames()).toEqual(sortedNames)
  })

  it('falls back to “Unknown student” when names can’t be loaded', async () => {
    const { overlay, rowNames } = setup(() => Promise.reject(new Error('offline')))
    overlay.render('r1', payload())
    await settle()
    expect(rowNames()).toEqual([UNKNOWN_STUDENT, UNKNOWN_STUDENT, UNKNOWN_STUDENT])
  })

  it('searches by name in the page, and the plugin hears nothing about it', async () => {
    const { container, overlay, onAction, rowNames } = setup()
    overlay.render('r1', payload())
    await settle()
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    expect(search.getAttribute('aria-label')).toBe('Search students')
    search.value = nameOf(B).split(' ')[0].toUpperCase()
    search.dispatchEvent(new Event('input'))
    expect(rowNames()).toEqual([nameOf(B)])
    search.value = 'zzzz'
    search.dispatchEvent(new Event('input'))
    expect(container.querySelector('tbody')?.textContent).toContain('No students match your search.')
    // A re-render from the plugin keeps the professor's query.
    overlay.render('r1', payload())
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('zzzz')
    expect(onAction).not.toHaveBeenCalled()
  })

  it('a choice says who it marks, shows which is pressed, and sends the handle, column and value', async () => {
    const { container, overlay, onAction } = setup()
    overlay.render('r1', payload())
    await settle()
    const present = container.querySelector<HTMLButtonElement>(`[aria-label="Present, ${nameOf(A)}"]`)!
    expect(present.getAttribute('aria-pressed')).toBe('true')
    const absent = container.querySelector<HTMLButtonElement>(`[aria-label="Absent, ${nameOf(B)}"]`)!
    expect(absent.getAttribute('aria-pressed')).toBe('false')
    absent.click()
    expect(onAction).toHaveBeenCalledWith({ slot: 'r1', student: B, column: 'status', value: 'absent' })
  })

  it('a select and a button send their values, and nothing carries a name', async () => {
    const { container, overlay, onAction } = setup()
    overlay.render('r1', payload())
    await settle()
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="Grade, ${nameOf(C)}"]`)!
    select.value = 'b'
    select.dispatchEvent(new Event('change'))
    container.querySelector<HTMLButtonElement>(`[aria-label="Remind, ${nameOf(A)}"]`)!.click()
    expect(onAction.mock.calls).toEqual([
      [{ slot: 'r1', student: C, column: 'grade', value: 'b' }],
      [{ slot: 'r1', student: A, column: 'nudge', value: 'remind' }],
    ])
    const sent = JSON.stringify(onAction.mock.calls)
    for (const s of PREVIEW_ROSTER) expect(sent).not.toContain(s.name)
  })

  it('renders plugin text as text', async () => {
    const { container, overlay } = setup()
    overlay.render('r1', payload({ columns: [{ key: 'note', header: '<b>Note</b>' }], rows: [{ student: A, cells: { note: { kind: 'text', text: '<img src=x onerror=alert(1)>' } } }] }))
    await settle()
    expect(container.querySelector('img, b')).toBeNull()
    expect(container.querySelector('tbody td')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('shows the empty text for an empty class', async () => {
    const { container, overlay } = setup()
    overlay.render('r1', payload({ rows: [] }))
    await settle()
    expect(container.querySelector('tbody')?.textContent).toBe('Nobody here yet.')
  })

  it('sits on the placeholder’s box, inside a layer clipped to the frame that passes other clicks through', async () => {
    const { container, overlay } = setup()
    overlay.place('r1', { x: 12, y: 300, width: 560, height: 232 })
    overlay.render('r1', payload())
    const layer = container.querySelector<HTMLElement>('[data-studio-roster="layer"]')!
    expect(layer.style).toMatchObject({ position: 'absolute', overflow: 'hidden', pointerEvents: 'none' })
    expect(container.style.position).toBe('relative')
    const box = container.querySelector<HTMLElement>('[data-studio-roster="r1"]')!
    expect(box.style).toMatchObject({ display: 'block', left: '12px', top: '300px', width: '560px', height: '232px', pointerEvents: 'auto' })
  })

  it('refuses more tables than a view needs', () => {
    const { overlay } = setup()
    for (let i = 0; i < ROSTER_MAX_SLOTS; i++) expect(overlay.render(`r${i}`, payload())).toBe(true)
    expect(overlay.render('extra', payload())).toBe(false)
  })
})
