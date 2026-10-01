import {
  Presentation,
  Type,
  ImageIcon,
  Table,
  Video,
  CalendarDays,
  Target,
  HelpCircle,
  AlertCircle,
  Minus,
  Quote,
  Sparkles,
  Mail,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { BlockType } from '@/lib/validations/course-about'

export interface BlockRegistryEntry {
  label: string
  description: string
  icon: LucideIcon
  /** 'common' = surfaced first in the insert menu (text, media, structured course content).
   *  'more'   = power-user blocks tucked behind a "More" group. */
  category: 'common' | 'more'
}

/* Order matters — entries render in this order within each category.
   Descriptions are written for professors, not designers — no jargon like
   "block", "embed", "CTA", "accordion".
   Hero is intentionally absent from the menu: it's now a fixed masthead slot
   at the top of the page, not an insertable section. */
export const BLOCK_REGISTRY: Record<BlockType, BlockRegistryEntry> = {
  'text': { label: 'Text', description: 'Write paragraphs, headings, and lists', icon: Type, category: 'common' },
  'image': { label: 'Image', description: 'Upload a picture with an optional caption', icon: ImageIcon, category: 'common' },
  'video': { label: 'Video', description: 'Paste a YouTube or Vimeo link', icon: Video, category: 'common' },
  'learning-outcomes': { label: 'Learning Outcomes', description: 'List what students will be able to do', icon: Target, category: 'common' },
  'syllabus': { label: 'Weekly Schedule', description: 'Week-by-week topics and readings', icon: CalendarDays, category: 'common' },
  'contact': { label: 'Contact & Office Hours', description: 'How students can reach you', icon: Mail, category: 'common' },
  'hero': { label: 'Course Masthead', description: 'Pinned to the top of the page', icon: Presentation, category: 'more' },
  'callout': { label: 'Note', description: 'A short note, warning, or reminder', icon: AlertCircle, category: 'more' },
  'highlight-box': { label: 'Highlight', description: 'Eye-catching info card with an icon', icon: Sparkles, category: 'more' },
  'quote': { label: 'Key Statement', description: 'A standout quote with the author', icon: Quote, category: 'more' },
  'table': { label: 'Table', description: 'A grid of rows and columns', icon: Table, category: 'more' },
  'faq': { label: 'Q & A', description: 'Frequently asked questions', icon: HelpCircle, category: 'more' },
  'divider': { label: 'Section Break', description: 'A line to separate sections', icon: Minus, category: 'more' },
}

export const BLOCK_CATEGORIES = [
  { key: 'common' as const, label: 'Common' },
  { key: 'more' as const, label: 'More' },
]

/* Canvas fields read as CONTENT, not as a form.
 *
 * A populated course page opened edit mode with 91 bordered input boxes on
 * screen, which is most of why professors described a Notion-style page builder
 * as "restricted by fields". The boxes are still inputs — same focus ring, same
 * keyboard behaviour, same hit area — they just stop drawing a border until you
 * reach for them. Hover shows where the editable regions are; focus shows which
 * one you are in.
 *
 * Kept as a class string rather than a wrapper component so each editor keeps
 * its own sizing and placeholder, which differ per block.
 */
export const CANVAS_FIELD =
  'border-transparent bg-transparent shadow-none transition-colors hover:bg-muted/50 focus-visible:bg-background focus-visible:border-input'
