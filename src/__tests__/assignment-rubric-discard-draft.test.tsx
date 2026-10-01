// RubricEditor "Discard draft" (#553-4): the way back from an unwanted generate/edit.
// The editor seeds from the DRAFT when one exists (it renders over the saved rubric),
// so without this control a stray draft made the approved rubric unreachable. Asserts:
//   1. the button shows only while the working rubric differs from the approved one;
//   2. clicking it calls the discard action and restores the APPROVED questions;
//   3. a failed discard leaves the draft in place (no silent local reset).
// The Generate confirm dialog is Radix-menu-gated (not jsdom-drivable — see
// quiz-rubric-editor.test.tsx's note) and is covered by the live browser QA pass.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RubricEditor } from '@/components/professor/assignments/RubricEditor'

const mockDiscard = vi.fn()
const mockSaveDraft = vi.fn()

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions', () => ({
  generateAssignmentRubric: vi.fn(),
  saveAssignmentRubric: vi.fn(),
  saveAssignmentRubricDraft: (...args: unknown[]) => mockSaveDraft(...args),
  discardAssignmentRubricDraft: (...args: unknown[]) => mockDiscard(...args),
  uploadRubricSourcePdf: vi.fn(),
}))

const SAVED = { questions: [{ label: 'Approved Q', points: 10, criteria: [], skills: [] }] }
const DRAFT = { questions: [{ label: 'Draft Q', points: 20, criteria: [], skills: [] }] }

function renderEditor(opts: { draft?: typeof DRAFT | null } = {}) {
  return render(
    <RubricEditor
      sectionId="sec-1"
      assignmentId="asg-1"
      initialRubric={SAVED}
      initialRubricDraft={opts.draft === undefined ? DRAFT : opts.draft}
      generateSources={{ content: null, pdfs: [], rubricSources: [] }}
      collapsible={false}
    />,
  )
}

beforeEach(() => {
  mockDiscard.mockReset()
  mockSaveDraft.mockReset().mockResolvedValue({ success: true })
})

describe('RubricEditor — Discard draft', () => {
  it('shows the button only while an unsaved draft differs from the approved rubric', () => {
    renderEditor() // seeds from DRAFT (differs from SAVED)
    expect(screen.getByRole('button', { name: /discard draft/i })).toBeInTheDocument()
    expect(screen.getByDisplayValue('Draft Q')).toBeInTheDocument()
  })

  it('hides the button when the editor matches the approved rubric', () => {
    renderEditor({ draft: null }) // seeds from SAVED
    expect(screen.queryByRole('button', { name: /discard draft/i })).not.toBeInTheDocument()
  })

  it('discard calls the server action and restores the approved questions', async () => {
    mockDiscard.mockResolvedValue({ success: true })
    renderEditor()

    fireEvent.click(screen.getByRole('button', { name: /discard draft/i }))

    await waitFor(() => expect(mockDiscard).toHaveBeenCalledWith('sec-1', 'asg-1'))
    // Editor swapped back to the saved rubric; the draft content is gone.
    expect(await screen.findByDisplayValue('Approved Q')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Draft Q')).not.toBeInTheDocument()
    // And with editor === approved, the control retires itself.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /discard draft/i })).not.toBeInTheDocument(),
    )
  })

  it('a failed discard keeps the draft on screen (server state unchanged, so must the editor)', async () => {
    mockDiscard.mockResolvedValue({ error: 'Could not discard the draft. Please try again.' })
    renderEditor()

    fireEvent.click(screen.getByRole('button', { name: /discard draft/i }))

    await waitFor(() => expect(mockDiscard).toHaveBeenCalled())
    expect(screen.getByDisplayValue('Draft Q')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /discard draft/i })).toBeInTheDocument()
  })
})
