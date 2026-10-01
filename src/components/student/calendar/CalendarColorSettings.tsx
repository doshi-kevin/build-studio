'use client'

// Interactive legend / color picker for the calendar. Each category shows its
// current color and opens a swatch dropdown; picking a swatch persists the
// choice (localStorage) and applies it live everywhere via the CSS variable.

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  CATEGORIES, COLOR_PALETTE, categoryColor, saveCalendarColor, resetCalendarColor,
  loadCalendarColors, type CategoryKey,
} from '@/lib/calendar/category-colors'

/** #rgb or #rrggbb. */
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const DEFAULT_HEX = '#4f7cff'

export function CalendarColorSettings() {
  // Seeded from saved overrides so the controls reflect the color actually in
  // effect (not a stale default) when a popover is opened. These controls live in
  // PopoverContent, which isn't server-rendered until opened, so reading
  // localStorage in a lazy initializer here is hydration-safe.
  const [colors, setColors] = useState<Partial<Record<CategoryKey, string>>>(loadCalendarColors)
  // Draft value of each category's custom-hex field — seeded from saved hex
  // overrides; oklch presets fall back to the placeholder but still highlight
  // their swatch via `colors`.
  const [hexDraft, setHexDraft] = useState<Partial<Record<CategoryKey, string>>>(() => {
    const hex: Partial<Record<CategoryKey, string>> = {}
    for (const [k, v] of Object.entries(loadCalendarColors())) {
      if (typeof v === 'string' && HEX_RE.test(v)) hex[k as CategoryKey] = v
    }
    return hex
  })

  const pick = (key: CategoryKey, value: string) => {
    saveCalendarColor(key, value)
    setColors((prev) => ({ ...prev, [key]: value }))
  }

  // Apply a hex only once it's syntactically valid, but always keep the field's
  // draft so the student can finish typing (e.g. "#3b" → "#3b82f6").
  const onHex = (key: CategoryKey, value: string) => {
    setHexDraft((prev) => ({ ...prev, [key]: value }))
    if (HEX_RE.test(value)) pick(key, value)
  }
  const hexFor = (key: CategoryKey) => hexDraft[key] ?? DEFAULT_HEX

  const reset = (key: CategoryKey) => {
    resetCalendarColor(key)
    setColors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {CATEGORIES.map((cat) => (
        <Popover key={cat.key}>
          <PopoverTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: categoryColor(cat.key) }} />
            {cat.label}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-2">
            <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{cat.label} color</p>
            <div className="grid grid-cols-4 gap-1.5">
              {COLOR_PALETTE.map((sw) => (
                <button
                  key={sw.value}
                  type="button"
                  title={sw.name}
                  aria-label={sw.name}
                  onClick={() => pick(cat.key, sw.value)}
                  className={cn(
                    'h-7 w-7 rounded-full border-2 transition',
                    colors[cat.key] === sw.value ? 'border-foreground' : 'border-transparent hover:border-border',
                  )}
                  style={{ backgroundColor: sw.value }}
                />
              ))}
            </div>
            {/* Custom color — native picker + exact hex entry */}
            <div className="mt-2 border-t border-border pt-2">
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Custom</p>
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  aria-label={`${cat.label} custom color picker`}
                  value={HEX_RE.test(hexFor(cat.key)) ? hexFor(cat.key) : DEFAULT_HEX}
                  onChange={(e) => onHex(cat.key, e.target.value)}
                  className="h-7 w-7 shrink-0 cursor-pointer rounded-full border border-border bg-transparent p-0"
                />
                <input
                  type="text"
                  inputMode="text"
                  aria-label={`${cat.label} hex color`}
                  value={hexFor(cat.key)}
                  onChange={(e) => onHex(cat.key, e.target.value.trim())}
                  placeholder="#4f7cff"
                  maxLength={7}
                  spellCheck={false}
                  className="h-7 w-24 rounded-xl border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => reset(cat.key)}
              className="mt-2 w-full rounded-xl px-1 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Reset to default
            </button>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  )
}
