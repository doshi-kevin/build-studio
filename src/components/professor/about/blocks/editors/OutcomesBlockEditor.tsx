'use client'

import { Plus, Trash2, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { LearningOutcomesBlock, LearningOutcome } from '@/lib/validations/course-about'
import { cn } from '@/lib/utils'
import { CANVAS_FIELD, useBlockEditor } from '../../block-editor'

interface Props {
  block: LearningOutcomesBlock
}

export function OutcomesBlockEditor({ block }: Props) {
  const { dispatch } = useBlockEditor()

  const update = (data: Partial<LearningOutcomesBlock['data']>) => {
    dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data } })
  }

  const updateOutcome = (id: string, changes: Partial<LearningOutcome>) => {
    update({
      outcomes: block.data.outcomes.map((o) => (o.id === id ? { ...o, ...changes } : o)),
    })
  }

  const addOutcome = () => {
    update({
      outcomes: [...block.data.outcomes, { id: crypto.randomUUID(), text: '', isCore: true }],
    })
  }

  const removeOutcome = (id: string) => {
    if (block.data.outcomes.length <= 1) return
    update({ outcomes: block.data.outcomes.filter((o) => o.id !== id) })
  }

  return (
    <div className="space-y-3">
      <Input
        value={block.data.title}
        onChange={(e) => update({ title: e.target.value })}
        placeholder="Section title..."
        className="font-semibold text-base border-none bg-transparent focus-visible:ring-0 p-0 h-auto"
      />

      {/* "Coming soon" toggle — students see a stub instead of the list */}
      <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
        <Checkbox
          checked={!!block.data.tba}
          onCheckedChange={(checked) => update({ tba: checked === true ? true : undefined })}
        />
        <span className="text-xs text-muted-foreground">
          Show as &ldquo;Coming soon&rdquo; to students until I&apos;m ready
        </span>
      </label>

      <div className="space-y-2">
        {block.data.outcomes.map((outcome) => (
          <div key={outcome.id} className="flex items-start gap-2 group/item">
            <GripVertical className="h-4 w-4 mt-2.5 text-muted-foreground opacity-0 group-hover/item:opacity-100 cursor-grab shrink-0" />
            <div className="flex-1">
              <Input
                value={outcome.text}
                onChange={(e) => updateOutcome(outcome.id, { text: e.target.value })}
                placeholder="Learning outcome..."
                className={cn('text-sm', CANVAS_FIELD)}
              />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Checkbox
                id={`core-${outcome.id}`}
                checked={outcome.isCore}
                onCheckedChange={(checked) => updateOutcome(outcome.id, { isCore: Boolean(checked) })}
              />
              <Label htmlFor={`core-${outcome.id}`} className="text-xs text-muted-foreground">Core</Label>
            </div>
            {block.data.outcomes.length > 1 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 mt-0.5 opacity-0 group-hover/item:opacity-100"
                onClick={() => removeOutcome(outcome.id)}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            )}
          </div>
        ))}
      </div>

      <Button variant="outline" size="sm" onClick={addOutcome}>
        <Plus className="h-3.5 w-3.5 mr-1.5" />
        Add Outcome
      </Button>
    </div>
  )
}
