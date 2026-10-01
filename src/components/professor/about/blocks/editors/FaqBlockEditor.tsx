'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import type { FaqBlock, FaqItem } from '@/lib/validations/course-about'
import { useBlockEditor } from '../../block-editor'
import { RichTextField } from '../../RichText'

interface Props {
  block: FaqBlock
}

export function FaqBlockEditor({ block }: Props) {
  const { dispatch } = useBlockEditor()

  const update = (data: Partial<FaqBlock['data']>) => {
    dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data } })
  }

  const updateItem = (id: string, changes: Partial<FaqItem>) => {
    update({
      items: block.data.items.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    })
  }

  const addItem = () => {
    update({
      items: [
        ...block.data.items,
        { id: crypto.randomUUID(), question: '', answer: { type: 'doc', content: [] } },
      ],
    })
  }

  const removeItem = (id: string) => {
    if (block.data.items.length <= 1) return
    update({ items: block.data.items.filter((item) => item.id !== id) })
  }

  return (
    <div className="space-y-3">
      <Input
        value={block.data.title}
        onChange={(e) => update({ title: e.target.value })}
        placeholder="Section title..."
        className="font-semibold text-base border-none bg-transparent focus-visible:ring-0 p-0 h-auto"
      />

      <Accordion type="multiple" className="space-y-2">
        {block.data.items.map((item) => (
          <AccordionItem key={item.id} value={item.id} className="border border-border rounded-lg px-3">
            <div className="flex items-center gap-2">
              <AccordionTrigger className="flex-1 py-2 text-sm font-medium hover:no-underline">
                {item.question || <span className="text-muted-foreground italic">Untitled question</span>}
              </AccordionTrigger>
              {block.data.items.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => removeItem(item.id)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              )}
            </div>
            <AccordionContent className="pb-3 space-y-2">
              <Input
                value={item.question}
                onChange={(e) => updateItem(item.id, { question: e.target.value })}
                placeholder="Question..."
                className="text-sm"
              />
              <RichTextField
                value={item.answer}
                onChange={(answer) => updateItem(item.id, { answer })}
                className="text-sm rounded-xl border border-border px-3 py-2"
              />
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>

      <Button variant="outline" size="sm" onClick={addItem}>
        <Plus className="h-3.5 w-3.5 mr-1.5" />
        Add Question
      </Button>
    </div>
  )
}
