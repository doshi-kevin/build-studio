'use client'

// Inline fill-in-the-blank authoring editor (Quizizz-style chips, Learnosity
// dashed-border look). The professor writes the sentence and clicks "Insert
// blank" wherever a word is missing; a chip appears inline with its accepted
// answer typed *inside* it and an ✕ to remove it. No separate blank list.
//
// It is a thin controller over a contenteditable div holding native widgets, and
// its single output is the canonical token text ({{blank:id:answers}}) via
// onChange — the parent stores that as questionText and derives content.blanks[]
// from it with parseBlanks(). Answers only ever live in this text; the server
// strips them before a student sees the question.

import { useCallback, useEffect, useRef } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { newBlankId, segmentFillInBlankText, serializeBlankToken } from '@/lib/quiz/fill-in-blank'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Build a chip element. The answer <input> lives inside a contentEditable=false
// wrapper so the surrounding rich text can't swallow it and it edits normally.
function chipHtml(id: string, answer: string): string {
  return (
    `<span class="fib-chip" contenteditable="false" data-id="${id}">` +
    `<button type="button" class="fib-x" tabindex="0" aria-label="Remove blank">×</button>` +
    `<input class="fib-ans" placeholder="e.g. USA, United States" value="${escapeHtml(answer)}" />` +
    `</span>`
  )
}

/** value (token text) → editor innerHTML (chips for tokens, escaped text between). */
function toHtml(value: string): string {
  const segs = segmentFillInBlankText(value ?? '')
  if (segs.length === 0) return ''
  return segs
    .map((s) =>
      s.type === 'text' ? escapeHtml(s.value) : chipHtml(s.id, s.acceptedAnswers.join(', ')),
    )
    .join('')
}

/** editor DOM → canonical token text. */
function fromDom(root: HTMLElement): string {
  let out = ''
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
    } else if (node instanceof HTMLElement) {
      if (node.classList.contains('fib-chip')) {
        const id = node.dataset.id || newBlankId()
        const input = node.querySelector('input.fib-ans') as HTMLInputElement | null
        const answers = (input?.value ?? '').split(',').map((a) => a.trim()).filter(Boolean)
        out += serializeBlankToken(id, answers)
      } else if (node.tagName === 'BR') {
        out += '\n'
      } else {
        out += node.textContent ?? ''
      }
    }
  })
  return out
}

export function InlineBlankEditor({
  value,
  onChange,
  placeholder = 'Write the sentence, then Insert blank where a word is missing…',
  frameless,
}: {
  value: string
  onChange: (tokenText: string) => void
  placeholder?: string
  /** Drop the editor's own border — for embedding in a parent frame
   *  (the studio card wraps it with the shared attach-strip frame). */
  frameless?: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Last text we emitted, so an external value change (reset/type-switch) re-renders
  // the DOM but our own edits don't clobber the caret.
  const lastEmitted = useRef<string | null>(null)

  const emit = useCallback(() => {
    if (!ref.current) return
    const text = fromDom(ref.current)
    lastEmitted.current = text
    onChange(text)
  }, [onChange])

  // Render DOM from value on mount and whenever value changes from the outside.
  useEffect(() => {
    if (!ref.current) return
    if (value === lastEmitted.current) return
    ref.current.innerHTML = toHtml(value)
    lastEmitted.current = value
  }, [value])

  const insertBlank = useCallback(() => {
    const editor = ref.current
    if (!editor) return
    const id = newBlankId()
    const tpl = document.createElement('template')
    tpl.innerHTML = chipHtml(id, '')
    const chip = tpl.content.firstChild as HTMLElement

    // Caret inside an existing blank → put the new one AFTER it, never nested.
    // (The button preventDefaults mousedown so focus stays put for this check.)
    const active = document.activeElement as HTMLElement | null
    const currentChip = active?.closest?.('.fib-chip') as HTMLElement | null
    if (currentChip && editor.contains(currentChip)) {
      currentChip.after(document.createTextNode(' '), chip, document.createTextNode(' '))
      emit()
      ;(chip.querySelector('input.fib-ans') as HTMLInputElement | null)?.focus()
      return
    }

    editor.focus()
    const sel = window.getSelection()
    let range: Range
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) range = sel.getRangeAt(0)
    else {
      range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
    }
    range.deleteContents()
    // pad the chip with spaces so words don't jam against it
    const before = document.createTextNode(' ')
    const after = document.createTextNode(' ')
    range.insertNode(after)
    range.insertNode(chip)
    range.insertNode(before)
    emit()
    // focus the new chip's answer input
    ;(chip.querySelector('input.fib-ans') as HTMLInputElement | null)?.focus()
  }, [emit])

  // Delegate: ✕ removes the chip; typing anywhere (incl. chip inputs) re-serializes.
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.classList.contains('fib-x')) {
        e.preventDefault()
        target.closest('.fib-chip')?.remove()
        emit()
        // The focused ✕ just vanished — return focus to the editor so a
        // keyboard user isn't dropped to <body>.
        ref.current?.focus()
      }
    },
    [emit],
  )

  return (
    <div className="relative">
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label="Question text with blanks"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={emit}
        onClick={onClick}
        // pb leaves room for the floating Insert-blank button so text never sits under it.
        className={cn(
          'fib-editor min-h-20 w-full bg-background px-3 pt-2 pb-12 text-sm leading-loose outline-none',
          !frameless && 'rounded-xl border-[1.5px] border-input focus:border-primary',
        )}
      />
      <Button
        type="button"
        size="sm"
        // Keep focus on whatever was active (editor caret or a chip input) so
        // insertBlank can tell where to drop the new blank.
        onMouseDown={(e) => e.preventDefault()}
        onClick={insertBlank}
        className="absolute bottom-2 left-2 h-7 gap-1 rounded-full px-3 text-xs shadow-sm"
      >
        <Plus className="h-3 w-3" /> Insert blank
      </Button>
    </div>
  )
}
