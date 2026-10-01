'use client'

import type { AboutBlock } from '@/lib/validations/course-about'
import { HeroBlockEditor } from './editors/HeroBlockEditor'
import { TextBlockEditor } from './editors/TextBlockEditor'
import { ImageBlockEditor } from './editors/ImageBlockEditor'
import { TableBlockEditor } from './editors/TableBlockEditor'
import { VideoBlockEditor } from './editors/VideoBlockEditor'
import { SyllabusBlockEditor } from './editors/SyllabusBlockEditor'
import { OutcomesBlockEditor } from './editors/OutcomesBlockEditor'
import { FaqBlockEditor } from './editors/FaqBlockEditor'
import { CalloutBlockEditor } from './editors/CalloutBlockEditor'
import { DividerBlockEditor } from './editors/DividerBlockEditor'
import { QuoteBlockEditor } from './editors/QuoteBlockEditor'
import { HighlightBlockEditor } from './editors/HighlightBlockEditor'
import { ContactBlockEditor } from './editors/ContactBlockEditor'

interface Props {
  block: AboutBlock
}

export function BlockRenderer({ block }: Props) {
  switch (block.type) {
    case 'hero': return <HeroBlockEditor block={block} />
    case 'text': return <TextBlockEditor block={block} />
    case 'image': return <ImageBlockEditor block={block} />
    case 'table': return <TableBlockEditor block={block} />
    case 'video': return <VideoBlockEditor block={block} />
    case 'syllabus': return <SyllabusBlockEditor block={block} />
    case 'learning-outcomes': return <OutcomesBlockEditor block={block} />
    case 'faq': return <FaqBlockEditor block={block} />
    case 'callout': return <CalloutBlockEditor block={block} />
    case 'divider': return <DividerBlockEditor />
    case 'quote': return <QuoteBlockEditor block={block} />
    case 'highlight-box': return <HighlightBlockEditor block={block} />
    case 'contact': return <ContactBlockEditor block={block} />
    default: return <div className="p-4 text-sm text-muted-foreground">Unknown block type</div>
  }
}
