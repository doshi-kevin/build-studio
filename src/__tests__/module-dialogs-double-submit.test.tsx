/**
 * Double-submit guard on the module dialogs.
 *
 * `disabled={isSubmitting}` is NOT sufficient on its own. The flag is set inside the
 * submit handler, and that handler only runs AFTER react-hook-form's async zod
 * resolver settles — so every click that lands before the first re-render gets its
 * own trip through the server action. Three fast clicks produced three modules.
 *
 * The oracle here is the number of server-action calls, not the button's disabled
 * attribute: asserting on `disabled` would pass even with the race intact, because
 * the attribute does eventually flip. What matters is that the second and third
 * submits never reach the action at all.
 *
 * The mocked action deliberately never resolves during the test, which holds the
 * in-flight window open — the exact condition (a slow request) under which a real
 * professor double-clicks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CreateModuleDialog } from '@/components/professor/modules/CreateModuleDialog'
import { ModuleDividerDialog } from '@/components/professor/modules/ModuleDividerDialog'
import { createModuleSchema } from '@/lib/validations/module'

const createModule = vi.fn()
const updateModule = vi.fn()
const createModuleDivider = vi.fn()
const updateModuleDivider = vi.fn()

vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/modules/actions', () => ({
  createModule: (...args: unknown[]) => createModule(...args),
  updateModule: (...args: unknown[]) => updateModule(...args),
  createModuleDivider: (...args: unknown[]) => createModuleDivider(...args),
  updateModuleDivider: (...args: unknown[]) => updateModuleDivider(...args),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const SECTION_ID = '8a2ac745-bbd2-4848-a4b6-aeac1e69bb4b'

/** A promise that never settles — keeps the action in flight for the whole test. */
const neverResolves = () => new Promise(() => {})

describe('module dialogs — double-submit guard', () => {
  beforeEach(() => {
    createModule.mockReset()
    createModuleDivider.mockReset()
    createModule.mockImplementation(neverResolves)
    createModuleDivider.mockImplementation(neverResolves)
  })

  it('creates exactly one module when Create Module is clicked three times rapidly', async () => {
    render(
      <CreateModuleDialog open onOpenChange={() => {}} sectionId={SECTION_ID} />,
    )

    fireEvent.change(screen.getByPlaceholderText('Introduction to Algorithms'), {
      target: { value: 'Week 1 — Tokenization' },
    })

    const submit = screen.getByRole('button', { name: /create module/i })
    // Same tick, no awaits between them: the race the professor actually hits.
    fireEvent.click(submit)
    fireEvent.click(submit)
    fireEvent.click(submit)

    await waitFor(() => expect(createModule).toHaveBeenCalled())
    expect(createModule).toHaveBeenCalledTimes(1)
  })

  /* Not a double-submit case, but the same instance-reuse root: the create-mode dialog
     stays mounted between opens, so its form state outlives the module it created. */
  it('reopens the New module dialog with a blank title after creating one', async () => {
    const { rerender } = render(
      <CreateModuleDialog open onOpenChange={() => {}} sectionId={SECTION_ID} />,
    )

    const title = () => screen.getByPlaceholderText('Introduction to Algorithms')
    fireEvent.change(title(), { target: { value: 'Week 1 — Tokenization' } })
    expect(title()).toHaveValue('Week 1 — Tokenization')

    // Close, then reopen the same mounted instance.
    rerender(<CreateModuleDialog open={false} onOpenChange={() => {}} sectionId={SECTION_ID} />)
    rerender(<CreateModuleDialog open onOpenChange={() => {}} sectionId={SECTION_ID} />)

    await waitFor(() => expect(title()).toHaveValue(''))
  })

  it('adds exactly one divider when Add divider is clicked three times rapidly', async () => {
    render(
      <ModuleDividerDialog open onOpenChange={() => {}} sectionId={SECTION_ID} />,
    )

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Unit 2' },
    })

    const submit = screen.getByRole('button', { name: /add divider/i })
    fireEvent.click(submit)
    fireEvent.click(submit)
    fireEvent.click(submit)

    await waitFor(() => expect(createModuleDivider).toHaveBeenCalled())
    expect(createModuleDivider).toHaveBeenCalledTimes(1)
  })
})

/**
 * Rejected input must SAY why. These inputs were all correctly refused but produced
 * no message, so the submit button just looked dead.
 */
describe('module validation messages', () => {
  it('rejects a whitespace-only title with the required-field message', () => {
    const result = createModuleSchema.safeParse({
      title: '   ',
      is_published: true,
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.message)).toContain('Title is required')
  })

  it('trims a padded title rather than storing the padding', () => {
    const result = createModuleSchema.safeParse({
      title: '  Week 1  ',
      is_published: true,
    })
    expect(result.success).toBe(true)
    expect(result.data?.title).toBe('Week 1')
  })

  it.each([0, 53, -1, 1.5])('rejects week %s with a readable message', (week) => {
    const result = createModuleSchema.safeParse({
      title: 'Valid title',
      is_published: true,
      week_number: week,
    })
    expect(result.success).toBe(false)
    const messages = result.error?.issues.map((i) => i.message) ?? []
    expect(messages.some((m) => /Week must be/.test(m))).toBe(true)
  })
})
