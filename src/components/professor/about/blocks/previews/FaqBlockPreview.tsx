'use client'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import type { FaqBlock } from '@/lib/validations/course-about'
import { RichTextView } from '../../RichText'

interface Props {
  block: FaqBlock
}

export function FaqBlockPreview({ block }: Props) {
  if (block.data.items.length === 0) return null

  return (
    <div className="space-y-3">
      {block.data.title && <h2 className="font-serif text-2xl text-foreground">{block.data.title}</h2>}
      <Accordion type="single" collapsible className="space-y-2">
        {block.data.items.map((item) => {
          if (!item.question) return null
          return (
            <AccordionItem key={item.id} value={item.id} className="border border-border rounded-lg px-4">
              <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="text-sm pb-3">
                {/* Rendered as the document it is stored as — the old flatten
                    dropped every list and every bold run. */}
                <RichTextView value={item.answer} />
              </AccordionContent>
            </AccordionItem>
          )
        })}
      </Accordion>
    </div>
  )
}
