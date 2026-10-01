// Tests for the shared formula-insert utility used by both the quiz
// wizard (QuestionEditorCard) and the modal question form
// (QuestionFormDialog). Guards against delimiter drift and ensures
// caret math lets multi-pick formulas stack cleanly.

import { describe, it, expect, vi } from 'vitest'
import {
  buildFormulaToken,
  insertAtCaret,
  advanceCaret,
} from '@/lib/quiz/formula-insert'

describe('buildFormulaToken', () => {
  it('wraps display math in $$…$$', () => {
    expect(buildFormulaToken('a^2 + b^2 = c^2', 'display')).toBe('$$a^2 + b^2 = c^2$$')
  })

  it('wraps inline math in $…$', () => {
    expect(buildFormulaToken('\\pi', 'inline')).toBe('$\\pi$')
  })

  it('does not escape or modify the latex body', () => {
    expect(buildFormulaToken('\\frac{1}{2}', 'display')).toBe('$$\\frac{1}{2}$$')
  })
})

describe('insertAtCaret', () => {
  function fakeTextarea(selectionStart: number, selectionEnd?: number) {
    return {
      selectionStart,
      selectionEnd: selectionEnd ?? selectionStart,
    } as HTMLTextAreaElement
  }

  it('splices the token at a collapsed caret and advances caret past it', () => {
    const { next, caret } = insertAtCaret('hello  world', '$$x$$', fakeTextarea(6))
    expect(next).toBe('hello $$x$$ world')
    expect(caret).toBe(6 + '$$x$$'.length)
  })

  it('replaces a selection range when the caret spans text', () => {
    const { next, caret } = insertAtCaret('hello BAD world', '$$x$$', fakeTextarea(6, 9))
    expect(next).toBe('hello $$x$$ world')
    expect(caret).toBe(6 + '$$x$$'.length)
  })

  it('appends on a new line when the textarea has no selection info', () => {
    const { next, caret } = insertAtCaret('prior line', '$$x$$', null)
    expect(next).toBe('prior line\n$$x$$')
    expect(caret).toBe(next.length)
  })

  it('returns the token alone when the current text is empty', () => {
    const { next, caret } = insertAtCaret('', '$$x$$', null)
    expect(next).toBe('$$x$$')
    expect(caret).toBe('$$x$$'.length)
  })

  it('stacks sequential inline picks with a space separator (guards against $a$$b$ glue)', () => {
    // Simulate the real multi-pick flow: first pick, then the caller
    // calls advanceCaret; on the second pick we read the new selectionStart.
    const textarea = fakeTextarea(0)
    const first = insertAtCaret('', '$a$', textarea)
    // Caller would call advanceCaret; we mimic that by updating the stub.
    textarea.selectionStart = first.caret
    textarea.selectionEnd = first.caret
    const second = insertAtCaret(first.next, '$b$', textarea)
    // `$a$$b$` breaks remark-math parsing; we pad with a space.
    expect(second.next).toBe('$a$ $b$')
    // Caret lands after the $b$ token, i.e. past the leading space too.
    expect(second.caret).toBe('$a$ $b$'.length)
  })

  it('stacks sequential display picks with a blank line (so each renders as its own block)', () => {
    const textarea = fakeTextarea(0)
    const first = insertAtCaret('', '$$a$$', textarea)
    textarea.selectionStart = first.caret
    textarea.selectionEnd = first.caret
    const second = insertAtCaret(first.next, '$$b$$', textarea)
    expect(second.next).toBe('$$a$$\n\n$$b$$')
    expect(second.caret).toBe('$$a$$\n\n$$b$$'.length)
  })

  it('pads the leading side when inserting a display token after plain text', () => {
    // `text$$x$$` would be interpreted as text followed by inline-ish display
    // math; the blank line makes remark-math render it as a proper block.
    const { next } = insertAtCaret('text', '$$x$$', fakeTextarea(4))
    expect(next).toBe('text\n\n$$x$$')
  })

  it('does not pad when the adjacent character is already whitespace', () => {
    const { next } = insertAtCaret('hello ', '$$x$$', fakeTextarea(6))
    expect(next).toBe('hello $$x$$')
  })
})

describe('advanceCaret', () => {
  it('is a no-op when the textarea is null', () => {
    expect(() => advanceCaret(null, 5)).not.toThrow()
  })

  it('schedules a setSelectionRange call on the textarea', async () => {
    const calls: Array<[number, number]> = []
    const textarea = {
      setSelectionRange(start: number, end: number) {
        calls.push([start, end])
      },
    } as unknown as HTMLTextAreaElement
    advanceCaret(textarea, 7)
    // rAF runs on the next frame, so poll the observable result rather than
    // sleeping a guessed number of milliseconds.
    await vi.waitFor(() => expect(calls).toEqual([[7, 7]]))
  })

  it('swallows errors from a textarea that unmounted between frames', async () => {
    /* The caret move is best-effort: the textarea can unmount between the rAF being
       scheduled and it running, and setSelectionRange then throws on a detached node.
       Asserting only "nothing propagated" would also pass if advanceCaret stopped
       calling setSelectionRange at all, so pin BOTH halves — the call was attempted,
       and the throw did not escape. */
    const setSelectionRange = vi.fn(() => {
      throw new Error('unmounted')
    })
    const textarea = { setSelectionRange } as unknown as HTMLTextAreaElement

    expect(() => advanceCaret(textarea, 3)).not.toThrow()

    await vi.waitFor(() => expect(setSelectionRange).toHaveBeenCalledWith(3, 3))
    expect(setSelectionRange).toHaveBeenCalledTimes(1)
  })
})
