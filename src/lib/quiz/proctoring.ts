// Client-side proctoring event capture module.
// Attaches global listeners for keydown, copy, paste, cut, blur, focus, visibilitychange.
// Buffers events and flushes them via a callback every FLUSH_INTERVAL_MS.
// Plain typing (alphanumeric keys without modifiers) is counted but NOT recorded
// as individual events — only the count is sent per batch for privacy.

import type { ProctoringEvent } from '@/lib/validations/proctoring'
import { MOD_CTRL, MOD_SHIFT, MOD_ALT, MOD_META } from '@/lib/validations/proctoring'

const FLUSH_INTERVAL_MS = 10_000 // 10 seconds
const MAX_BUFFER_SIZE = 500      // flush if buffer gets too large

// Keys that are meaningful for proctoring and kept as events
const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'CapsLock', 'NumLock', 'ScrollLock', 'Insert', 'PrintScreen', 'Pause',
])

export interface ProctoringCaptureOptions {
  attemptStartedAt: string // ISO string from attempt.startedAt
  getCurrentQuestionIndex: () => number // callback to get current question index
  onFlush: (events: ProctoringEvent[], batchIndex: number, keystrokeCount: number) => void | Promise<unknown>
}

export class ProctoringCapture {
  private buffer: ProctoringEvent[] = []
  private batchIndex = 0
  private keystrokeCount = 0 // plain typing counter (not stored as events)
  private startTime: number
  private options: ProctoringCaptureOptions
  private flushInterval: ReturnType<typeof setInterval> | null = null
  private attached = false

  // Bound handler references for cleanup
  private handleKeydown: (e: KeyboardEvent) => void
  private handleCopy: () => void
  private handlePaste: () => void
  private handleCut: () => void
  private handleFocus: () => void
  private handleBlur: () => void
  private handleVisibility: () => void

  constructor(options: ProctoringCaptureOptions) {
    this.options = options
    this.startTime = new Date(options.attemptStartedAt).getTime()

    this.handleKeydown = this._onKeydown.bind(this)
    this.handleCopy = () => this._push({ t: this._offset(), type: 'cp', qi: this._qi() })
    this.handlePaste = () => this._push({ t: this._offset(), type: 'ps', qi: this._qi() })
    this.handleCut = () => this._push({ t: this._offset(), type: 'ct', qi: this._qi() })
    this.handleFocus = () => this._push({ t: this._offset(), type: 'fc', qi: this._qi() })
    this.handleBlur = () => this._push({ t: this._offset(), type: 'bl', qi: this._qi() })
    this.handleVisibility = () => {
      const type = document.hidden ? 'bl' : 'fc'
      this._push({ t: this._offset(), type, qi: this._qi() })
    }
  }

  attach() {
    if (this.attached) return
    this.attached = true

    document.addEventListener('keydown', this.handleKeydown, true)
    document.addEventListener('copy', this.handleCopy, true)
    document.addEventListener('paste', this.handlePaste, true)
    document.addEventListener('cut', this.handleCut, true)
    window.addEventListener('focus', this.handleFocus)
    window.addEventListener('blur', this.handleBlur)
    document.addEventListener('visibilitychange', this.handleVisibility)

    this.flushInterval = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
  }

  detach() {
    if (!this.attached) return
    this.attached = false

    document.removeEventListener('keydown', this.handleKeydown, true)
    document.removeEventListener('copy', this.handleCopy, true)
    document.removeEventListener('paste', this.handlePaste, true)
    document.removeEventListener('cut', this.handleCut, true)
    window.removeEventListener('focus', this.handleFocus)
    window.removeEventListener('blur', this.handleBlur)
    document.removeEventListener('visibilitychange', this.handleVisibility)

    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }

    // Final flush on detach
    this.flush()
  }

  flush() {
    if (this.buffer.length === 0 && this.keystrokeCount === 0) return
    const batch = [...this.buffer]
    const count = this.keystrokeCount
    this.buffer = []
    this.keystrokeCount = 0
    this.options.onFlush(batch, this.batchIndex, count)
    this.batchIndex++
  }

  /** Awaitable flush — ensures the server action completes before proceeding. */
  async flushAsync(): Promise<void> {
    if (this.buffer.length === 0 && this.keystrokeCount === 0) return
    const batch = [...this.buffer]
    const count = this.keystrokeCount
    this.buffer = []
    this.keystrokeCount = 0
    await this.options.onFlush(batch, this.batchIndex, count)
    this.batchIndex++
  }

  private _onKeydown(e: KeyboardEvent) {
    // Skip held-down key repeats — only track distinct presses
    if (e.repeat) return
    // Skip bare modifier key presses — they're not meaningful on their own
    const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift'])
    if (MODIFIER_KEYS.has(e.key)) return

    let mod = 0
    if (e.ctrlKey) mod |= MOD_CTRL
    if (e.shiftKey) mod |= MOD_SHIFT
    if (e.altKey) mod |= MOD_ALT
    if (e.metaKey) mod |= MOD_META

    const hasModifier = mod > 0
    const isSpecial = SPECIAL_KEYS.has(e.key)

    // Only record events for modifier combos and special keys.
    // Plain typing (a-z, 0-9, symbols) is just counted for the total.
    if (!hasModifier && !isSpecial) {
      this.keystrokeCount++
      return
    }

    const event: ProctoringEvent = {
      t: this._offset(),
      type: 'kd',
      key: e.key,
      qi: this._qi(),
    }
    if (mod > 0) event.mod = mod
    this._push(event)
  }

  /** Push an external event (e.g. from video proctoring) into the batch buffer. */
  pushExternalEvent(event: ProctoringEvent) {
    this._push(event)
  }

  private _push(event: ProctoringEvent) {
    this.buffer.push(event)
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.flush()
    }
  }

  private _offset(): number {
    return Math.max(0, Date.now() - this.startTime)
  }

  private _qi(): number {
    return this.options.getCurrentQuestionIndex()
  }
}
