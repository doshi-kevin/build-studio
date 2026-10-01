// Numeric input — free typing with validation on blur.
// Uses local state during editing so backspace, clearing, and typing
// all work naturally. Clamps to min/max only when the user leaves the field.

'use client'

import * as React from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface NumericInputProps
  extends Omit<React.ComponentProps<typeof Input>, 'type' | 'onChange' | 'value'> {
  value: number | string | null | undefined
  onChange: (value: string) => void
  min?: number
  max?: number
  /** Allow empty value (renders as '') rather than forcing a number */
  allowEmpty?: boolean
  /** Accept a decimal point (e.g. Target SE 0.3). Default is integer-only. */
  decimal?: boolean
  /** Fire on every keystroke (unclamped raw value). Useful for live validation previews. */
  onLiveChange?: (value: string) => void
  /** Render as a real number field (native stepper + up/down arrow keys). Blur
   *  clamping still comes from here, so min/max stay authoritative. */
  spinner?: boolean
}

export function NumericInput({
  value,
  onChange,
  min,
  max,
  allowEmpty = true,
  decimal = false,
  onLiveChange,
  spinner = false,
  className,
  /* These three MUST be destructured out of `...props`, not left in it. The JSX spreads
     `{...props}` AFTER our own handlers, so anything still inside it silently replaces ours
     on the DOM node — and all three carry load-bearing logic: onKeyDown commits on Enter
     (#619), onBlur commits on blur, onFocus flips the local-vs-parent sync. A caller passing
     any of them would have quietly lost that behaviour with no error and nothing visible.
     Pulled out here and called through explicitly below, so both run. */
  onKeyDown: onKeyDownProp,
  onFocus: onFocusProp,
  onBlur: onBlurProp,
  ...props
}: NumericInputProps) {
  // Local display state — lets the user type freely without clamping
  const [local, setLocal] = React.useState(String(value ?? ''))
  const [focused, setFocused] = React.useState(false)

  // Sync from parent when not focused (e.g. external reset or initial load)
  React.useEffect(() => {
    if (!focused) setLocal(String(value ?? ''))
  }, [value, focused])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    // Allow empty, minus sign, and digits only
    if (raw === '' || raw === '-') {
      setLocal(raw)
      onLiveChange?.(raw)
      return
    }
    // Strip non-numeric except a leading minus (and, in decimal mode, one dot)
    let cleaned = decimal
      ? raw.replace(/[^\d.-]/g, '').replace(/(?!^)-/g, '')
      : raw.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '')
    if (decimal) {
      // Keep only the first dot so "0.3.5" can't be typed
      const firstDot = cleaned.indexOf('.')
      if (firstDot !== -1) {
        cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
      }
    }
    setLocal(cleaned)
    onLiveChange?.(cleaned)
  }

  function handleFocus(e: React.FocusEvent<HTMLInputElement>) {
    setFocused(true)
    onFocusProp?.(e)
  }

  /* The clamp-and-commit step, shared by blur and Enter.
     It used to live only in onBlur, which meant a value confirmed with Enter was never
     committed: if the next action unmounted the field before a blur landed — closing the
     points popover, say — the edit was silently discarded and the old value came back
     (#619). For a field that decides how a question is scored, that is real data loss. */
  function commit() {
    if (local === '' || local === '-') {
      if (!allowEmpty && min !== undefined) {
        const clamped = String(min)
        setLocal(clamped)
        onChange(clamped)
      } else {
        setLocal('')
        onChange('')
      }
      return
    }

    let num = decimal ? parseFloat(local) : parseInt(local, 10)
    if (isNaN(num)) {
      const fallback = allowEmpty ? '' : String(min ?? 0)
      setLocal(fallback)
      onChange(fallback)
      return
    }

    if (min !== undefined && num < min) num = min
    if (max !== undefined && num > max) num = max

    const clamped = String(num)
    setLocal(clamped)
    onChange(clamped)
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    setFocused(false)
    commit()
    onBlurProp?.(e)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    /* isComposing: with an IME active (Japanese, Chinese, Korean…) Enter CONFIRMS the
       candidate being composed rather than meaning "I'm done". Committing here would swallow
       that keystroke and cut the composition short, so let it through untouched. */
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      // preventDefault: inside a form (the quiz studio is one) Enter would submit and can
      // unmount this field before the value is ever committed.
      e.preventDefault()
      commit()
    }
    onKeyDownProp?.(e)
  }

  return (
    <Input
      type={spinner ? 'number' : 'text'}
      inputMode={decimal ? 'decimal' : 'numeric'}
      // A number field owns its own keystroke filtering; pattern/step belong to it instead.
      {...(spinner ? { min, max, step: decimal ? 'any' : 1 } : { pattern: decimal ? '-?[0-9.]*' : '-?[0-9]*' })}
      value={local}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      // A focused number field eats the wheel and steps its own value, so scrolling
      // the surrounding panel would silently change what the user typed. Blur first.
      onWheel={spinner ? (e) => e.currentTarget.blur() : undefined}
      className={cn('tabular-nums', className)}
      {...props}
    />
  )
}
