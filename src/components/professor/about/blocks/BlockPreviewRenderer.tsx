'use client'

import type { AboutBlock } from '@/lib/validations/course-about'
import { HeroBlockPreview } from './previews/HeroBlockPreview'
import { TextBlockPreview } from './previews/TextBlockPreview'
import { ImageBlockPreview } from './previews/ImageBlockPreview'
import { TableBlockPreview } from './previews/TableBlockPreview'
import { VideoBlockPreview } from './previews/VideoBlockPreview'
import { SyllabusBlockPreview } from './previews/SyllabusBlockPreview'
import { OutcomesBlockPreview } from './previews/OutcomesBlockPreview'
import { FaqBlockPreview } from './previews/FaqBlockPreview'
import { CalloutBlockPreview } from './previews/CalloutBlockPreview'
import { DividerBlockPreview } from './previews/DividerBlockPreview'
import { QuoteBlockPreview } from './previews/QuoteBlockPreview'
import { HighlightBlockPreview } from './previews/HighlightBlockPreview'
import { ContactBlockPreview } from './previews/ContactBlockPreview'

interface Props {
  block: AboutBlock
}

export function BlockPreviewRenderer({ block }: Props) {
  switch (block.type) {
    case 'hero': return <HeroBlockPreview block={block} />
    case 'text': return <TextBlockPreview block={block} />
    case 'image': return <ImageBlockPreview block={block} />
    case 'table': return <TableBlockPreview block={block} />
    case 'video': return <VideoBlockPreview block={block} />
    case 'syllabus': return <SyllabusBlockPreview block={block} />
    case 'learning-outcomes': return <OutcomesBlockPreview block={block} />
    case 'faq': return <FaqBlockPreview block={block} />
    case 'callout': return <CalloutBlockPreview block={block} />
    case 'divider': return <DividerBlockPreview />
    case 'quote': return <QuoteBlockPreview block={block} />
    case 'highlight-box': return <HighlightBlockPreview block={block} />
    case 'contact': return <ContactBlockPreview block={block} />
    default: return null
  }
}
