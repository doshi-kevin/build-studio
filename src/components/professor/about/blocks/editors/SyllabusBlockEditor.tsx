'use client'

import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { SyllabusBlock, SyllabusWeek } from '@/lib/validations/course-about'
import { CANVAS_FIELD, useBlockEditor } from '../../block-editor'

interface Props {
  block: SyllabusBlock
}

export function SyllabusBlockEditor({ block }: Props) {
  const { dispatch } = useBlockEditor()
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set(block.data.weeks.map((w) => w.id)))

  const update = (data: Partial<SyllabusBlock['data']>) => {
    dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data } })
  }

  const updateWeek = (weekId: string, changes: Partial<SyllabusWeek>) => {
    update({
      weeks: block.data.weeks.map((w) => (w.id === weekId ? { ...w, ...changes } : w)),
    })
  }

  const addWeek = () => {
    const nextWeek = block.data.weeks.length + 1
    const newWeek: SyllabusWeek = {
      id: crypto.randomUUID(),
      week: nextWeek,
      topic: '',
      description: '',
      readings: '',
    }
    setExpandedWeeks((prev) => new Set([...prev, newWeek.id]))
    update({ weeks: [...block.data.weeks, newWeek] })
  }

  const removeWeek = (weekId: string) => {
    update({
      weeks: block.data.weeks
        .filter((w) => w.id !== weekId)
        .map((w, i) => ({ ...w, week: i + 1 })),
    })
  }

  const toggleExpand = (weekId: string) => {
    setExpandedWeeks((prev) => {
      const next = new Set(prev)
      if (next.has(weekId)) next.delete(weekId)
      else next.add(weekId)
      return next
    })
  }

  return (
    <div className="space-y-3">
      <Input
        value={block.data.title}
        onChange={(e) => update({ title: e.target.value })}
        placeholder="Section title..."
        className="font-semibold text-base border-none bg-transparent focus-visible:ring-0 p-0 h-auto"
      />

      {/* "Coming soon" toggle — students see a stub instead of the week list */}
      <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
        <Checkbox
          checked={!!block.data.tba}
          onCheckedChange={(checked) => update({ tba: checked === true ? true : undefined })}
        />
        <span className="text-xs text-muted-foreground">
          Show as &ldquo;Coming soon&rdquo; to students until the schedule is ready
        </span>
      </label>

      <div className="space-y-2">
        {block.data.weeks.map((week) => {
          const isExpanded = expandedWeeks.has(week.id)
          return (
            <div key={week.id} className="rounded-lg border border-border">
              <div
                className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50"
                onClick={() => toggleExpand(week.id)}
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className="text-sm font-medium text-muted-foreground shrink-0">
                  Week {week.week}
                </span>
                <span className="text-sm truncate">
                  {week.topic || <span className="text-muted-foreground italic">Untitled</span>}
                </span>
                <div className="flex-1" />
                {block.data.weeks.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={(e) => { e.stopPropagation(); removeWeek(week.id) }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                  </Button>
                )}
              </div>

              {isExpanded && (
                <div className={cn('px-3 pb-3 pt-1 space-y-2 border-t border-border')}>
                  <Input
                    value={week.topic}
                    onChange={(e) => updateWeek(week.id, { topic: e.target.value })}
                    placeholder="Topic..."
                    className={cn('text-sm', CANVAS_FIELD)}
                  />
                  <Textarea
                    value={week.description}
                    onChange={(e) => updateWeek(week.id, { description: e.target.value })}
                    placeholder="Description..."
                    className={cn('text-sm resize-none min-h-[60px]', CANVAS_FIELD)}
                  />
                  <Input
                    value={week.readings}
                    onChange={(e) => updateWeek(week.id, { readings: e.target.value })}
                    placeholder="Readings / materials..."
                    className={cn('text-sm', CANVAS_FIELD)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      <Button variant="outline" size="sm" onClick={addWeek}>
        <Plus className="h-3.5 w-3.5 mr-1.5" />
        Add Week
      </Button>
    </div>
  )
}
