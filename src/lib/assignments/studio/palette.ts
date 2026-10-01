import {
  Type, Code2, Heading, Minus,
  HelpCircle, FormInput, ListChecks, type LucideIcon,
} from 'lucide-react'
import type { StudioCellType } from './notebook-model'

export interface PaletteItem {
  kind: string
  title: string
  description: string
  icon: LucideIcon
  cellType: StudioCellType
  template: string
}

export interface PaletteGroup {
  label: string
  items: PaletteItem[]
}

export const CELL_PALETTE: PaletteGroup[] = [
  {
    label: 'Basic',
    items: [
      { kind: 'markdown', title: 'Text block', description: 'Rich text, LaTeX and chemistry', icon: Type, cellType: 'markdown', template: '' },
      { kind: 'code', title: 'Code', description: 'Code block', icon: Code2, cellType: 'code', template: '' },
      { kind: 'heading', title: 'Heading', description: 'Section heading', icon: Heading, cellType: 'markdown', template: '## Section heading' },
      { kind: 'divider', title: 'Divider', description: 'Visual separator', icon: Minus, cellType: 'markdown', template: '\n---\n' },
    ],
  },
  {
    label: 'Questions',
    items: [
      {
        kind: 'question', title: 'Question', description: 'Open-ended question', icon: HelpCircle, cellType: 'markdown',
        template: '### Question\n\nWrite the question here.\n\n_Write your answer below._',
      },
      {
        kind: 'form', title: 'Written response', description: 'Collect a written response', icon: FormInput, cellType: 'markdown',
        template: '**Your response:**\n\n_Students write their answer here._',
      },
      {
        kind: 'mcq', title: 'Multiple choice', description: 'MCQ question', icon: ListChecks, cellType: 'markdown',
        template: '### Multiple choice\n\nWhat is the correct answer?\n\n- [ ] Option A\n- [ ] Option B\n- [ ] Option C\n- [ ] Option D',
      },
    ],
  },
]
