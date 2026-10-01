// Regression tests for the QuestionEditorCard image attach seam (studio UI
// polish pass). The attach strip added replace-in-place semantics via a new
// `attachImage` closure, reachable through a plain hidden <input type="file">
// (no Radix interaction — so it's jsdom-testable, unlike the type/bank Selects
// which stay in Playwright/visual). These assert the invisible correctness the
// visual walkthrough can't reliably pin down:
//   1. non-image files are rejected before any upload (drag/paste bypass the
//      input's `accept`, so the guard is the only defense);
//   2. a successful attach reports the signed URL + path to the parent and
//      uploads under `${sectionId}/quiz-images/...` (sectionId-first is
//      load-bearing for the course-materials RLS read policy);
//   3. replacing an image deletes the OLD path (no storage orphan) — but only
//      when the new upload SUCCEEDS (a failed upload must keep the old image).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import {
  QuestionEditorCard,
  createBlankQuestion,
  type WizardQuestion,
} from '@/components/professor/quizzes/wizard/QuestionEditorCard'
import { uploadFile, deleteFile } from '@/lib/supabase/storage'
import { toast } from 'sonner'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/supabase/storage', () => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}))
// QuestionEditorCard renders InsertFromLibraryDialog (closed) when sectionId is
// set; stub its server-action import so the module resolves without a real call.
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions', () => ({
  getLibraryForSection: vi.fn().mockResolvedValue({ images: [], formulas: [] }),
}))

// jsdom has no scrollIntoView; Radix Select touches it on render.
Element.prototype.scrollIntoView = vi.fn()

const mockUpload = vi.mocked(uploadFile)
const mockDelete = vi.mocked(deleteFile)
const mockToastError = vi.mocked(toast.error)

/** A blank MC question, optionally carrying an already-attached image. */
function question(overrides: Partial<WizardQuestion> = {}): WizardQuestion {
  return { ...createBlankQuestion('multiple_choice'), ...overrides }
}

/** Render the card and hand back the hidden file input (the browse entry). */
function renderCard(q: WizardQuestion, onChange = vi.fn()) {
  const view = render(
    <QuestionEditorCard question={q} onChange={onChange} sectionId="sec-1" />,
  )
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
  return { onChange, input, ...view }
}

const imageFile = (name = 'diagram.png') =>
  new File(['bytes'], name, { type: 'image/png' })

beforeEach(() => {
  vi.clearAllMocks()
  mockUpload.mockResolvedValue({
    data: {
      url: 'signed-url',
      path: 'sec-1/quiz-images/x_123.png',
      fileName: 'x.png',
      fileSize: 5,
      mimeType: 'image/png',
    },
    error: null,
  })
  mockDelete.mockResolvedValue({ error: null })
})

describe('QuestionEditorCard image attach', () => {
  it('rejects a non-image file before uploading', async () => {
    const { input, onChange } = renderCard(question())
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    })

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Only image files can be attached'),
    )
    expect(mockUpload).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('uploads under {sectionId}/quiz-images/{id} and reports the URL + path to the parent', async () => {
    const q = question()
    const file = imageFile()
    const { input, onChange } = renderCard(q)
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(mockUpload).toHaveBeenCalledWith(file, `sec-1/quiz-images/${q.clientId}`)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: 'signed-url',
        imagePath: 'sec-1/quiz-images/x_123.png',
      }),
    )
  })

  it('deletes the previous image path when a replacement upload succeeds', async () => {
    mockUpload.mockResolvedValue({
      data: {
        url: 'new-url',
        path: 'sec-1/quiz-images/new.png',
        fileName: 'new.png',
        fileSize: 5,
        mimeType: 'image/png',
      },
      error: null,
    })
    const { input, onChange } = renderCard(
      question({ imageUrl: 'old-url', imagePath: 'sec-1/quiz-images/old.png' }),
    )
    fireEvent.change(input, { target: { files: [imageFile('replacement.png')] } })

    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith('sec-1/quiz-images/old.png'),
    )
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: 'sec-1/quiz-images/new.png' }),
    )
  })

  it('keeps the old image (no delete, no change) when the replacement upload fails', async () => {
    mockUpload.mockResolvedValue({ data: null, error: 'network down' })
    const { input, onChange } = renderCard(
      question({ imageUrl: 'old-url', imagePath: 'sec-1/quiz-images/old.png' }),
    )
    fireEvent.change(input, { target: { files: [imageFile('replacement.png')] } })

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockDelete).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removeImage deletes the stored path and clears the URL/path on the parent', async () => {
    const { onChange } = renderCard(
      question({ imageUrl: 'old-url', imagePath: 'sec-1/quiz-images/old.png' }),
    )
    fireEvent.click(screen.getByRole('button', { name: /remove image/i }))

    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith('sec-1/quiz-images/old.png'),
    )
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: null, imagePath: null }),
    )
  })
})
