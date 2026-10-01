import type {
  AboutBlock,
  HeroBlock,
  TextBlock,
  ImageBlock,
  TableBlock,
  VideoBlock,
  SyllabusBlock,
  LearningOutcomesBlock,
  FaqBlock,
  CalloutBlock,
  DividerBlock,
  QuoteBlock,
  HighlightBoxBlock,
  ContactBlock,
  BlockType,
} from '@/lib/validations/course-about'

const EMPTY_DOC = { type: 'doc' as const, content: [] }

export function createHeroBlock(): HeroBlock {
  return {
    id: crypto.randomUUID(),
    type: 'hero',
    data: {
      bannerSrc: '',
      bannerAlt: '',
      title: '',
      subtitle: '',
      instructor: '',
      semester: '',
      credits: '',
      introVideoUrl: '',
      /* Empty so the default Hero never ships a stray "Get Started" button
         to students — the action button is opt-in via the editor. */
      ctaText: '',
      ctaUrl: '',
    },
  }
}

export function createTextBlock(): TextBlock {
  return { id: crypto.randomUUID(), type: 'text', data: { content: { ...EMPTY_DOC } } }
}

export function createImageBlock(): ImageBlock {
  return { id: crypto.randomUUID(), type: 'image', data: { src: '', alt: '', caption: '', alignment: 'center' } }
}

export function createTableBlock(): TableBlock {
  return {
    id: crypto.randomUUID(),
    type: 'table',
    data: { title: '', hasHeaderRow: true, rows: [['Header 1', 'Header 2', 'Header 3'], ['', '', ''], ['', '', '']] },
  }
}

export function createVideoBlock(): VideoBlock {
  return { id: crypto.randomUUID(), type: 'video', data: { url: '', caption: '' } }
}

export function createSyllabusBlock(): SyllabusBlock {
  return {
    id: crypto.randomUUID(),
    type: 'syllabus',
    data: {
      title: 'Weekly Schedule',
      weeks: [{ id: crypto.randomUUID(), week: 1, topic: '', description: '', readings: '' }],
    },
  }
}

export function createOutcomesBlock(): LearningOutcomesBlock {
  return {
    id: crypto.randomUUID(),
    type: 'learning-outcomes',
    data: {
      title: 'Learning Outcomes',
      outcomes: [{ id: crypto.randomUUID(), text: '', isCore: true }],
    },
  }
}

export function createFaqBlock(): FaqBlock {
  return {
    id: crypto.randomUUID(),
    type: 'faq',
    data: {
      title: 'Frequently Asked Questions',
      items: [{ id: crypto.randomUUID(), question: '', answer: { ...EMPTY_DOC } }],
    },
  }
}

export function createCalloutBlock(): CalloutBlock {
  return {
    id: crypto.randomUUID(),
    type: 'callout',
    data: { variant: 'info', title: '', content: { ...EMPTY_DOC } },
  }
}

export function createDividerBlock(): DividerBlock {
  return { id: crypto.randomUUID(), type: 'divider', data: {} as Record<string, never> }
}

export function createQuoteBlock(): QuoteBlock {
  return { id: crypto.randomUUID(), type: 'quote', data: { text: '', attribution: '' } }
}

export function createHighlightBlock(): HighlightBoxBlock {
  return {
    id: crypto.randomUUID(),
    type: 'highlight-box',
    data: { variant: 'feature', title: '', content: { ...EMPTY_DOC } },
  }
}

export function createContactBlock(): ContactBlock {
  return {
    id: crypto.randomUUID(),
    type: 'contact',
    data: {
      name: '',
      title: '',
      email: '',
      officeLocation: '',
      officeHours: '',
      zoomUrl: '',
      responseTime: '',
    },
  }
}

/** Create a default block by type */
export function createBlock(type: BlockType): AboutBlock {
  const factories: Record<BlockType, () => AboutBlock> = {
    'hero': createHeroBlock,
    'text': createTextBlock,
    'image': createImageBlock,
    'table': createTableBlock,
    'video': createVideoBlock,
    'syllabus': createSyllabusBlock,
    'learning-outcomes': createOutcomesBlock,
    'faq': createFaqBlock,
    'callout': createCalloutBlock,
    'divider': createDividerBlock,
    'quote': createQuoteBlock,
    'highlight-box': createHighlightBlock,
    'contact': createContactBlock,
  }
  return factories[type]()
}
