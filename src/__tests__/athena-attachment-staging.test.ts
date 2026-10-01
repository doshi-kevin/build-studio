/**
 * Two guards on the attachment path that Athena's honesty depends on.
 *
 * 1. `addFiles` reports what it actually staged. The panel needs this: on the quiz
 *    studio the same file ALSO goes to course materials, and the confirmation note
 *    claims Athena can read it. If a rejected file still reached that branch, the
 *    professor would be told "I've got it and can read it" about a file that was
 *    toasted away — which is #652 inverted, on the path the #652 fix introduced.
 *
 * 2. `materializeForModel` bounds how much of a text file it pastes into the prompt.
 *    A .txt may be up to 20MB, which is roughly 5M tokens against a 1M context, and
 *    attachments are re-inlined on EVERY later turn of a thread. Without the bound
 *    one accepted file bricks the conversation permanently rather than once.
 */

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAthenaAttachments } from '@/lib/hooks/use-athena-attachments'
import { materializeForModel } from '@/lib/ai/athena-attachments-server'
import type { AthenaAttachmentLimits } from '@/lib/ai/professor-assistant/models'

const LIMITS: AthenaAttachmentLimits = {
  maxFiles: 2,
  maxBytesPerFile: 1000,
  maxOfficeBytes: 1000,
  acceptedExt: ['pdf', 'txt'],
}

/** A File of a given size without allocating the bytes — only .size is read. */
function fakeFile(name: string, size: number): File {
  const f = new File(['x'], name)
  Object.defineProperty(f, 'size', { value: size })
  return f
}

function setup() {
  return renderHook(() =>
    useAthenaAttachments({ limits: LIMITS, endpoint: '/api/never-called', fields: {} }),
  )
}

describe('useAthenaAttachments.addFiles reports what it staged', () => {
  it('returns the file when it passes validation', () => {
    const { result } = setup()
    let staged: File[] = []
    act(() => {
      staged = result.current.addFiles([fakeFile('notes.pdf', 10)])
    })
    expect(staged).toHaveLength(1)
    expect(staged[0].name).toBe('notes.pdf')
  })

  it('returns nothing for an unsupported type, so a caller can skip its own work', () => {
    const { result } = setup()
    let staged: File[] = []
    act(() => {
      staged = result.current.addFiles([fakeFile('deck.zip', 10)])
    })
    expect(staged).toEqual([])
    expect(result.current.attachments).toEqual([])
  })

  it('returns nothing for an oversized file', () => {
    const { result } = setup()
    let staged: File[] = []
    act(() => {
      staged = result.current.addFiles([fakeFile('huge.pdf', 5000)])
    })
    expect(staged).toEqual([])
  })

  it('returns only the files that fit once the per-thread cap is reached', () => {
    const { result } = setup()
    act(() => {
      result.current.addFiles([fakeFile('a.pdf', 10), fakeFile('b.pdf', 10)])
    })
    let staged: File[] = []
    act(() => {
      staged = result.current.addFiles([fakeFile('c.pdf', 10)])
    })
    // maxFiles is 2 and both slots are taken, so the third stages nothing.
    expect(staged).toEqual([])
    expect(result.current.attachments).toHaveLength(2)
  })
})

describe('materializeForModel bounds inlined text', () => {
  /** Storage stub: every download returns the given body. */
  const dbWith = (body: string) =>
    ({
      storage: {
        from: () => ({
          download: async () => ({
            data: {
              text: async () => body,
              arrayBuffer: async () => new ArrayBuffer(1),
            },
            error: null,
          }),
        }),
      },
    }) as never

  const TEXT_PATH = 'inst/sec/conv/11111111-1111-4111-8111-111111111111.txt'
  const PDF_PATH = 'inst/sec/conv/11111111-1111-4111-8111-111111111111.pdf'

  it('passes a text file through whole when it is inside the bound', async () => {
    const body = 'a'.repeat(100_000)
    const out = await materializeForModel(dbWith(body), TEXT_PATH)
    expect(out).toEqual({ type: 'text', text: body })
  })

  it('cuts a text file that exceeds the bound, and says that it did', async () => {
    const out = await materializeForModel(dbWith('b'.repeat(100_001)), TEXT_PATH)
    expect(out?.type).toBe('text')
    const text = (out as { text: string }).text
    // The marker is load-bearing: without it the model answers confidently from a
    // file it only saw the front of, which reads as a wrong answer, not a partial one.
    expect(text).toContain('Truncated here')
    expect(text.startsWith('b'.repeat(100_000))).toBe(true)
    expect(text).not.toContain('b'.repeat(100_001))
  })

  it('leaves binary attachments alone — the bound is for inlined characters only', async () => {
    const out = await materializeForModel(dbWith('ignored'), PDF_PATH)
    // A PDF rides as a file part the provider pages itself; the upload size limit
    // already bounds it, and truncating base64 would corrupt the document.
    expect(out?.type).toBe('file')
    expect((out as { mediaType: string }).mediaType).toBe('application/pdf')
  })
})
