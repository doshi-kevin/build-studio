/**
 * The v2 plugin kit in jsdom: controls are labelled and carry the 44 px classes kit.css
 * sizes, the three required states keep `data-kit-state`, RosterTable sends the host
 * handles and cells and nothing else, and the data hooks page, patch and batch the way
 * the Bridge expects.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import {
  BarChart,
  Button,
  Checkbox,
  DataTable,
  DateField,
  Empty,
  ErrorState,
  formatDate,
  Loading,
  makeUseRecords,
  makeUseRoster,
  NumberField,
  ProgressBar,
  RosterTable,
  SearchField,
  SegmentedControl,
  Select,
  StatCard,
  Switch,
  Tabs,
  TextField,
  today,
  type PluginRecord,
} from '@/lib/studio/kit/v2/components'
import { makeUseRequest } from '@/lib/studio/kit/components'
import { ROSTER_HEADER_PX, ROSTER_ROW_PX, ROSTER_SEARCH_PX, rosterHeight } from '@/lib/studio/runtime/roster-layout'

// Comments stripped: the checks are about rules, not prose.
const css = readFileSync('public/studio-runtime/v2/kit.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the rule whose selector list includes `selector` exactly. */
function rulesFor(selector: string): string {
  const out: string[] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) out.push(m[2])
  }
  return out.join(';')
}

const setStudio = (value: unknown) => Object.defineProperty(globalThis, 'ScholeraStudio', { value, configurable: true, writable: true })
afterEach(() => {
  delete (globalThis as { ScholeraStudio?: unknown }).ScholeraStudio
})

describe('kit.css', () => {
  it('makes every control class at least 44 px', () => {
    expect(css).toMatch(/--kit-target:\s*44px/)
    for (const cls of ['.kit-button', '.kit-input', '.kit-segment', '.kit-tab', '.kit-switch']) {
      expect(rulesFor(cls), cls).toMatch(/min-height:\s*var\(--kit-target\)/)
    }
    expect(rulesFor('.kit-check')).toMatch(/min-height:\s*var\(--kit-target\)/)
  })
  it('loads nothing (the frame allows no images) and honours reduced motion', () => {
    expect(css).not.toMatch(/url\(|@import/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^@]*\.kit-spinner \{ animation: none; \}/)
  })
  it('collapses a grid to one column under 640 px', () => {
    expect(rulesFor('.kit-grid')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/)
    expect(css).toMatch(/@media \(min-width: 640px\) \{\s*\.kit-grid-2, \.kit-grid-3, \.kit-grid-4/)
  })
})

describe('controls', () => {
  it('are labelled and carry the sized classes', () => {
    const noop = () => {}
    render(
      <>
        <Button onPress={noop}>Save</Button>
        <TextField label="Title" value="" onChange={noop} hint="Shown to students" />
        <NumberField label="Points" value={3} onChange={noop} />
        <DateField label="Due" value="2026-10-03" onChange={noop} />
        <SearchField label="Search questions" value="" onChange={noop} />
        <Select label="Week" value="" onChange={noop} options={[{ value: 'w1', label: 'Week 1' }]} placeholder="Pick a week" />
        <Checkbox label="Done" checked={false} onChange={noop} />
        <Switch label="Show answers" checked onChange={noop} description="After the deadline" />
        <SegmentedControl label="Filter" value="open" onChange={noop} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }]} />
        <Tabs label="Sections" value="a" onChange={noop} tabs={[{ value: 'a', label: 'Overview' }, { value: 'b', label: 'Queue', count: 4 }]} />
      </>,
    )
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('kit-button', 'kit-button-primary')
    for (const name of ['Title', 'Points', 'Due', 'Search questions', 'Week']) expect(screen.getByLabelText(name)).toHaveClass('kit-input')
    expect(screen.getByLabelText('Title')).toHaveAccessibleDescription('Shown to students')
    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeInTheDocument()
    const sw = screen.getByRole('switch', { name: 'Show answers' })
    expect(sw).toHaveClass('kit-switch')
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(sw).toHaveAccessibleDescription('After the deadline')
    expect(screen.getByRole('radiogroup', { name: 'Filter' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Open' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Open' })).toHaveClass('kit-segment')
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Queue 4' })).toHaveClass('kit-tab')
  })
  it('a segmented control moves with the arrow keys, one tab stop', () => {
    const onChange = vi.fn()
    render(<SegmentedControl label="Filter" value="all" onChange={onChange} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }]} />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1])
    fireEvent.keyDown(radios[0], { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('done')
  })
  it('a number field reports only valid numbers in range', () => {
    const onChange = vi.fn()
    render(<NumberField label="Points" value={5} onChange={onChange} min={0} max={10} />)
    const input = screen.getByLabelText('Points')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.change(input, { target: { value: '12' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '7' } })
    expect(onChange).toHaveBeenCalledWith(7)
  })
})

describe('data display', () => {
  it('a table is a named, focusable scroll region with its own empty row', () => {
    render(<DataTable label="Submissions" columns={[{ key: 't', header: 'Title' }, { key: 's', header: 'Score', align: 'end' }]} rows={[]} emptyText="No submissions yet." />)
    expect(screen.getByRole('region', { name: 'Submissions' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('table', { name: 'Submissions' })).toBeInTheDocument()
    expect(screen.getByText('No submissions yet.')).toHaveAttribute('colspan', '2')
    expect(screen.getByRole('columnheader', { name: 'Score' })).toHaveClass('kit-cell-end')
  })
  it('a stat of zero is neutral; other values keep their tone', () => {
    const { container } = render(
      <>
        <StatCard label="Late" value={0} tone="danger" />
        <StatCard label="Absent" value="0" tone="danger" />
        <StatCard label="Missing" value={3} tone="danger" />
      </>,
    )
    const tones = [...container.querySelectorAll('.kit-stat')].map((n) => n.className)
    expect(tones).toEqual(['kit-stat kit-stat-neutral', 'kit-stat kit-stat-neutral', 'kit-stat kit-stat-danger'])
  })
  it('a progress bar is a named progressbar; bars print their values', () => {
    render(
      <>
        <ProgressBar label="Graded" value={30} max={40} />
        <BarChart label="Answers" data={[{ label: 'A', value: 4 }, { label: 'B', value: 8 }]} valueSuffix=" votes" />
      </>,
    )
    const bar = screen.getByRole('progressbar', { name: 'Graded' })
    expect(bar).toHaveAttribute('aria-valuenow', '30')
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('8 votes')).toBeInTheDocument()
    expect(screen.getByRole('figure', { name: 'Answers' })).toBeInTheDocument()
  })
})

describe('the required states', () => {
  it('carry data-kit-state, and ErrorState shows only fixed copy', () => {
    const retry = vi.fn()
    const { container } = render(
      <>
        <Loading />
        <Empty title="No cards yet" description="Add the first term." />
        <ErrorState onRetry={retry} />
      </>,
    )
    expect([...container.querySelectorAll('[data-kit-state]')].map((e) => e.getAttribute('data-kit-state'))).toEqual(['loading', 'empty', 'error'])
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})

describe('RosterTable', () => {
  const roster = () => ({ render: vi.fn(), place: vi.fn(), remove: vi.fn() })
  const props = {
    label: 'Attendance',
    students: ['st_aaaaaaaaaaaaaaaaaaaa', 'st_bbbbbbbbbbbbbbbbbbbb'],
    columns: [{ key: 'status', header: 'Today' }],
    cells: (s: string) => ({
      status: {
        kind: 'choice' as const,
        value: s.startsWith('st_a') ? 'present' : null,
        options: [
          { value: 'present', label: 'Present', tone: 'success' as const },
          { value: 'absent', label: 'Absent but this label is far too long', tone: 'danger' as const },
        ],
      },
      stray: { kind: 'text' as const, text: 'not a column' },
    }),
  }

  it('reserves the shared layout height and sends handles and cells only', () => {
    const api = roster()
    let handler: ((d: unknown) => void) | null = null
    setStudio({ context: { view: 'professor' }, roster: api, on: (_: string, h: (d: unknown) => void) => ((handler = h), () => (handler = null)) })
    const onAction = vi.fn()
    const { container, unmount } = render(<RosterTable {...props} onAction={onAction} />)

    const slot = container.querySelector('[data-kit-roster]') as HTMLElement
    expect(rosterHeight(2, false)).toBe(ROSTER_HEADER_PX + 2 * ROSTER_ROW_PX)
    expect(slot.style.height).toBe(`${rosterHeight(2, false)}px`)
    expect(slot).toHaveAttribute('aria-hidden', 'true')
    expect(slot.textContent).toBe('')

    const [name, payload] = api.render.mock.calls[0]
    expect(name).toMatch(/^[a-z0-9]{1,16}$/)
    expect(name).toBe(slot.getAttribute('data-kit-roster'))
    expect(payload).toEqual({
      label: 'Attendance',
      sort: 'name',
      searchable: false,
      columns: [{ key: 'status', header: 'Today' }],
      rows: [
        { student: 'st_aaaaaaaaaaaaaaaaaaaa', cells: { status: { kind: 'choice', value: 'present', options: [{ value: 'present', label: 'Present', tone: 'success' }, { value: 'absent', label: 'Absent but this label is', tone: 'danger' }] } } },
        { student: 'st_bbbbbbbbbbbbbbbbbbbb', cells: { status: { kind: 'choice', value: null, options: [{ value: 'present', label: 'Present', tone: 'success' }, { value: 'absent', label: 'Absent but this label is', tone: 'danger' }] } } },
      ],
      emptyText: 'No students yet.',
    })
    expect(api.place).toHaveBeenCalledWith(name, expect.objectContaining({ x: 0, y: 0 }))

    // Only clicks on this slot reach the plugin.
    act(() => handler?.({ slot: 'other', student: 'st_x', column: 'status', value: 'present' }))
    act(() => handler?.({ slot: name, student: 'st_bbbbbbbbbbbbbbbbbbbb', column: 'status', value: 'absent' }))
    expect(onAction).toHaveBeenCalledExactlyOnceWith('st_bbbbbbbbbbbbbbbbbbbb', 'status', 'absent')

    unmount()
    expect(api.remove).toHaveBeenCalledWith(name)
    expect(handler).toBeNull()
  })
  it('a large class gets search by default, and the box grows by the search row', () => {
    const api = roster()
    setStudio({ context: { view: 'professor' }, roster: api })
    const students = Array.from({ length: 30 }, (_, i) => `st_${String(i).padStart(20, '0')}`)
    const { container } = render(<RosterTable label="Queue" students={students} columns={[]} cells={() => ({})} sort="given" />)
    expect(api.render.mock.calls[0][1]).toMatchObject({ searchable: true, sort: 'given' })
    expect((container.querySelector('[data-kit-roster]') as HTMLElement).style.height).toBe(`${ROSTER_SEARCH_PX + ROSTER_HEADER_PX + 30 * ROSTER_ROW_PX}px`)
  })
  it('drops what the host would refuse (a bad column key, a one-option choice) instead of the frame', () => {
    const api = roster()
    setStudio({ context: { view: 'professor' }, roster: api })
    render(
      <RosterTable
        label="Queue"
        students={['st_aaaaaaaaaaaaaaaaaaaa']}
        columns={[{ key: 'Bad Key', header: 'Bad' }, { key: 'state', header: 'State' }, { key: 'state', header: 'Again' }]}
        cells={() => ({ state: { kind: 'choice', value: null, options: [{ value: 'x', label: 'X', tone: 'info' }] } })}
      />,
    )
    const payload = api.render.mock.calls[0][1]
    expect(payload.columns).toEqual([{ key: 'state', header: 'State' }])
    expect(payload.rows[0].cells).toEqual({})
  })
  it.each([
    ['no runtime (tests, v1)', undefined],
    ['a v1 runtime without roster', { context: { view: 'professor' } }],
    ['a student view', { context: { view: 'student' }, roster: { render: vi.fn(), place: vi.fn(), remove: vi.fn() } }],
  ])('degrades to Empty with %s', (_name, studio) => {
    if (studio) setStudio(studio)
    const { container } = render(<RosterTable {...props} />)
    expect(container.querySelector('[data-kit-state="empty"]')).not.toBeNull()
    expect(container.querySelector('[data-kit-roster]')).toBeNull()
  })
})

type Note = { text: string }
const rec = (id: string, text = id): PluginRecord<Note> => ({ id, data: { text }, mine: true, createdAt: 't', updatedAt: 't' })
const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => rec(`r${from + i}`))

describe('useRecords', () => {
  it('pages through records.list until a short page', async () => {
    const request = vi.fn(async (_m: string, args?: unknown) => {
      const offset = (args as { offset: number }).offset
      return offset < 200 ? page(offset, 100) : page(offset, 37)
    })
    const { result } = renderHook(() => makeUseRecords(request)<Note>('notes'))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.records).toHaveLength(237)
    expect(request.mock.calls.map((c) => c[1])).toEqual([0, 100, 200].map((offset) => ({ collection: 'notes', limit: 100, offset })))
  })
  it('stops at 1000 records', async () => {
    const request = vi.fn(async (_m: string, args?: unknown) => page((args as { offset: number }).offset, 100))
    const { result } = renderHook(() => makeUseRecords(request)<Note>('notes'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.records).toHaveLength(1000)
    expect(request).toHaveBeenCalledTimes(10)
  })
  it('a write patches the list without reloading; a failed write reloads and resolves false', async () => {
    let fail = false
    const request = vi.fn(async (method: string, args?: unknown) => {
      if (method === 'records.list') return [rec('a')]
      if (fail) throw { code: 'invalid' }
      if (method === 'records.create') return rec('b', (args as { data: Note }).data.text)
      return null
    })
    const { result } = renderHook(() => makeUseRecords(request)<Note>('notes'))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.create({ text: 'about b' }, 'st_bbbbbbbbbbbbbbbbbbbb')
    })
    expect(saved).toBe(true)
    expect(request).toHaveBeenCalledWith('records.create', { collection: 'notes', data: { text: 'about b' }, student: 'st_bbbbbbbbbbbbbbbbbbbb' })
    expect(result.current.records.map((r) => r.id)).toEqual(['a', 'b'])
    expect(request.mock.calls.filter((c) => c[0] === 'records.list')).toHaveLength(1)

    fail = true
    await act(async () => {
      saved = await result.current.remove(result.current.records[0])
    })
    expect(saved).toBe(false)
    await waitFor(() => expect(request.mock.calls.filter((c) => c[0] === 'records.list')).toHaveLength(2))
  })
  it('saveMany sends batches of at most 50 and applies each result', async () => {
    const request = vi.fn(async (method: string, args?: unknown) => {
      if (method === 'records.list') return []
      const items = (args as { items: { op: string }[] }).items
      return { results: items.map((_, i) => ({ ok: true, record: rec(`n${request.mock.calls.length}-${i}`) })) }
    })
    const { result } = renderHook(() => makeUseRecords(request)<Note>('notes'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.saveMany(Array.from({ length: 120 }, (_, i) => ({ op: 'create' as const, data: { text: `x${i}` }, student: 'st_aaaaaaaaaaaaaaaaaaaa' })))
    })
    expect(saved).toBe(true)
    const batches = request.mock.calls.filter((c) => c[0] === 'records.batch').map((c) => (c[1] as { items: unknown[] }).items.length)
    expect(batches).toEqual([50, 50, 20])
    expect((request.mock.calls.find((c) => c[0] === 'records.batch')![1] as { items: unknown[] }).items[0]).toEqual({ op: 'create', data: { text: 'x0' }, student: 'st_aaaaaaaaaaaaaaaaaaaa' })
    expect(result.current.records).toHaveLength(120)
  })
  it('a partly failed batch resolves false and reloads', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'records.list') return [rec('a')]
      return { results: [{ ok: true, record: null }, { ok: false, code: 'not_available' }] }
    })
    const { result } = renderHook(() => makeUseRecords(request)<Note>('notes'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.saveMany([{ op: 'delete', record: result.current.records[0] }, { op: 'update', record: rec('zz'), data: { text: 'y' } }])
    })
    expect(saved).toBe(false)
    expect(request).toHaveBeenCalledWith('records.batch', { collection: 'notes', items: [{ op: 'delete', recordId: 'a' }, { op: 'update', recordId: 'zz', data: { text: 'y' } }] })
    await waitFor(() => expect(request.mock.calls.filter((c) => c[0] === 'records.list')).toHaveLength(2))
  })
  it('a failed load is an error, and retry loads again', async () => {
    let calls = 0
    const request = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw { code: 'failed' }
      return []
    })
    const { result } = renderHook(() => makeUseRecords(request)<Note>('notes'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    act(() => result.current.retry())
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })
})

describe('useRoster', () => {
  it('returns the handles from course.roster', async () => {
    const request = vi.fn(async () => ({ students: [{ handle: 'st_aaaaaaaaaaaaaaaaaaaa' }, { handle: 'st_bbbbbbbbbbbbbbbbbbbb' }] }))
    const useRoster = makeUseRoster(makeUseRequest(request))
    const { result } = renderHook(() => useRoster())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.students).toEqual(['st_aaaaaaaaaaaaaaaaaaaa', 'st_bbbbbbbbbbbbbbbbbbbb'])
    expect(request).toHaveBeenCalledWith('course.roster', null)
  })
})

describe('date helpers', () => {
  it('today is YYYY-MM-DD in local time, and a bare date never shifts a day', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(formatDate('2026-03-01', 'long')).not.toMatch(/February/)
    expect(formatDate('2026-03-01', 'long')).toMatch(/March/)
    expect(formatDate('not a date')).toBe('not a date')
  })
})
