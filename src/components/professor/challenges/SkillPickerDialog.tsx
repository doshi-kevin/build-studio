/**
 * SkillPickerDialog — a searchable picker window for linking skills to a
 * challenge. Sections can have 70+ skills, so the create form shows a compact
 * summary and delegates the actual glancing/picking to this dedicated dialog.
 *
 * Selection is live (toggling a row updates the parent immediately); "Done" just
 * closes the window.
 *
 * Type: Client Component
 */
'use client'

import { useMemo, useState } from 'react'
import { Tags, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface SkillPickerDialogProps {
  skills: { id: string; name: string }[]
  selected: string[]
  onChange: (ids: string[]) => void
}

export function SkillPickerDialog({ skills, selected, onChange }: SkillPickerDialogProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? skills.filter((s) => s.name.toLowerCase().includes(q)) : skills
  }, [skills, query])

  const selectedSet = new Set(selected)

  function toggle(id: string) {
    onChange(selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id])
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Tags className="h-3.5 w-3.5" aria-hidden="true" />
          {selected.length > 0 ? 'Edit skills' : 'Add skills'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Link skills</DialogTitle>
          <DialogDescription>
            Pick the skills this challenge builds. Completing it nudges each student’s mastery.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder="Search skills…"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <ScrollArea className="h-64 rounded-md border border-border p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No skills match “{query}”.</p>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((s) => (
                <label
                  key={s.id}
                  htmlFor={`skill-pick-${s.id}`}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                >
                  <Checkbox
                    id={`skill-pick-${s.id}`}
                    checked={selectedSet.has(s.id)}
                    onCheckedChange={() => toggle(s.id)}
                  />
                  <span className="truncate text-sm">{s.name}</span>
                </label>
              ))}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="sm:justify-between">
          <span className="text-xs text-muted-foreground self-center">{selected.length} selected</span>
          <Button type="button" onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
