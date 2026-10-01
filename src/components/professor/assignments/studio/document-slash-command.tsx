/**
 * Slash command for the Notion-style document studio.
 *
 * This is the ONLY block-insertion surface now that the left tool rail is gone, so it folds in
 * everything the rail used to offer: the basic blocks, the academic inserts (equation, LaTeX,
 * chemistry, chart, table), the question scaffolds, image upload, and the two non-block tools
 * (Solver, Python notebook) via handlers the studio passes in.
 *
 * Ordered Basic → Academic → Advanced. Novel exposes no command groups, so the ordering plus
 * icons carry the grouping (dynamic headers would break while the list is being filtered).
 *
 * Type: Client module (used inside the DocumentStudio client component)
 */
import {
  Text, Heading1, Heading2, Heading3, List, ListOrdered, CheckSquare, TextQuote, Code, Minus,
  Sigma, Pi, FlaskConical, BarChart3, Map as MapIcon, Table as TableIcon, Image as ImageIcon,
  Bot, NotebookPen, ListChecks, ArrowLeftRight, Braces, ToggleLeft, MessageSquareText, Info,
  ChevronRight, Youtube,
} from 'lucide-react'
import { createSuggestionItems, Command, renderItems } from 'novel'
import type { Editor, Range } from '@tiptap/core'
import { CHART_DEFAULTS } from './ChartNode'
import { MAP_DEFAULT } from './MapNode'
import { MATCH_DEFAULT } from './MatchNode'
import { SOLVER_DEFAULT } from './SolverNode'

/**
 * The remaining non-block tools (image upload / Python notebook) need component state (the file
 * picker, the router). Rather than thread those handlers into the slash items at render — which
 * makes the items non-static and trips the refs-during-render lint — the items dispatch a window
 * event and the studio listens for it. That keeps this whole module static.
 */
export const STUDIO_TOOL_EVENT = 'scholera:studio-tool'
export type StudioTool = 'image' | 'python' | 'video' | 'table'
/** Event payload: the tool, plus the doc position to insert at (captured from the command's range,
 * since the native file dialog blurs the editor and the selection can't be re-read reliably after). */
export interface StudioToolDetail { tool: StudioTool; pos?: number }
const fireTool = (tool: StudioTool, pos?: number) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<StudioToolDetail>(STUDIO_TOOL_EVENT, { detail: { tool, pos } }))
}
const insertNode = (editor: Editor, range: Range, type: string, data: unknown) =>
  editor.chain().focus().deleteRange(range).insertContent({ type, attrs: { data: JSON.stringify(data) } }).run()

/** Insert an EquationNode block (equation / LaTeX / chemistry all seed the same block). */
function insertEquation(editor: Editor, range: Range, latex: string) {
  editor.chain().focus().deleteRange(range).insertContent({ type: 'equation', attrs: { latex } }).run()
}

// Question scaffolds the professor fills in — inserted as HTML so they become real nodes. Uses
// only doc-supported blocks (paragraph/list/quote); unsupported nodes would be dropped.
const QUESTION_HTML: Record<string, string> = {
  mcq:
    '<p><strong>Question:</strong> Write the question here.</p>' +
    '<ul><li>Option A</li><li>Option B</li><li>Option C</li><li>Option D</li></ul>' +
    '<p><em>Correct answer:</em> </p>',
  fill: '<p><strong>Fill in the blank:</strong> The ____ is ____.</p>',
  tf: '<p><strong>True or False:</strong> Write the statement here.</p><ul><li>True</li><li>False</li></ul>',
  short: '<p><strong>Question:</strong> Write the question here.</p><blockquote><p>Answer:</p></blockquote>',
}

const insertHtml = (editor: Editor, range: Range, html: string) =>
  editor.chain().focus().deleteRange(range).insertContent(html).run()

/** The document studio's slash items — static (tool commands fire a window event; see fireTool). */
export const documentSlashItems = createSuggestionItems([
    // ---- Basic blocks ----
    {
      title: 'Text', description: 'Plain paragraph.', searchTerms: ['p', 'paragraph', 'text'],
      icon: <Text size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleNode('paragraph', 'paragraph').run(),
    },
    {
      title: 'Heading 1', description: 'Big section heading.', searchTerms: ['title', 'h1', 'big'],
      icon: <Heading1 size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
    },
    {
      title: 'Heading 2', description: 'Medium section heading.', searchTerms: ['h2', 'subtitle'],
      icon: <Heading2 size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
    },
    {
      title: 'Heading 3', description: 'Small section heading.', searchTerms: ['h3', 'subtitle'],
      icon: <Heading3 size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
    },
    {
      title: 'Bullet List', description: 'A simple bulleted list.', searchTerms: ['unordered', 'point', 'ul'],
      icon: <List size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      title: 'Numbered List', description: 'A list with numbering.', searchTerms: ['ordered', 'ol'],
      icon: <ListOrdered size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      title: 'To-do List', description: 'Track tasks with checkboxes.', searchTerms: ['todo', 'task', 'check'],
      icon: <CheckSquare size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
    },
    {
      title: 'Quote', description: 'Capture a quote.', searchTerms: ['blockquote', 'quote'],
      icon: <TextQuote size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleNode('paragraph', 'paragraph').toggleBlockquote().run(),
    },
    {
      title: 'Callout', description: 'Highlighted note (info / tip / warning).', searchTerms: ['callout', 'note', 'info', 'tip', 'warning', 'aside'],
      icon: <Info size={18} />,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).insertContent({ type: 'callout', attrs: { variant: 'info' }, content: [{ type: 'paragraph' }] }).run(),
    },
    {
      title: 'Code', description: 'A monospace code block.', searchTerms: ['codeblock', 'snippet'],
      icon: <Code size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      title: 'Toggle', description: 'A collapsible section.', searchTerms: ['toggle', 'collapse', 'details', 'accordion', 'expand'],
      icon: <ChevronRight size={18} />,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range)
          .insertContent({
            type: 'details',
            content: [
              { type: 'detailsSummary', content: [{ type: 'text', text: 'Toggle' }] },
              { type: 'detailsContent', content: [{ type: 'paragraph' }] },
            ],
          })
          .run(),
    },
    {
      title: 'Divider', description: 'A horizontal divider.', searchTerms: ['hr', 'rule', 'line', 'separator'],
      icon: <Minus size={18} />,
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },

    // ---- Academic ----
    {
      title: 'Equation', description: 'A math equation with a symbol toolbar.', searchTerms: ['math', 'equation', 'katex', 'formula'],
      icon: <Sigma size={18} />,
      command: ({ editor, range }) => insertEquation(editor, range, 'E = mc^2'),
    },
    {
      title: 'LaTeX', description: 'Start from a LaTeX fraction.', searchTerms: ['latex', 'fraction', 'math'],
      icon: <Pi size={18} />,
      command: ({ editor, range }) => insertEquation(editor, range, '\\frac{a}{b}'),
    },
    {
      title: 'Chemistry', description: 'A mhchem reaction.', searchTerms: ['chemistry', 'mhchem', 'reaction', 'ce'],
      icon: <FlaskConical size={18} />,
      command: ({ editor, range }) => insertEquation(editor, range, '\\ce{2 H2 + O2 -> 2 H2O}'),
    },
    {
      title: 'Chart', description: 'Line, bar or scatter — edit inline.', searchTerms: ['chart', 'bar', 'scatter', 'data', 'graph', 'plot'],
      icon: <BarChart3 size={18} />,
      command: ({ editor, range }) => insertNode(editor, range, 'chart', CHART_DEFAULTS.line),
    },
    {
      title: 'Map', description: 'Interactive map with named markers.', searchTerms: ['map', 'location', 'marker', 'geography', 'place'],
      icon: <MapIcon size={18} />,
      command: ({ editor, range }) => insertNode(editor, range, 'map', MAP_DEFAULT),
    },
    {
      title: 'Table', description: 'Pick a size, then insert a table.', searchTerms: ['table', 'grid', 'rows', 'columns'],
      icon: <TableIcon size={18} />,
      command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); fireTool('table') },
    },

    // ---- Advanced: question scaffolds ----
    {
      title: 'Multiple choice', description: 'MCQ scaffold to fill in.', searchTerms: ['question', 'mcq', 'multiple'],
      icon: <ListChecks size={18} />,
      command: ({ editor, range }) => insertHtml(editor, range, QUESTION_HTML.mcq),
    },
    {
      title: 'Short answer', description: 'Question + answer space.', searchTerms: ['question', 'short', 'answer'],
      icon: <MessageSquareText size={18} />,
      command: ({ editor, range }) => insertHtml(editor, range, QUESTION_HTML.short),
    },
    {
      title: 'True or False', description: 'A true/false question.', searchTerms: ['question', 'true', 'false', 'tf'],
      icon: <ToggleLeft size={18} />,
      command: ({ editor, range }) => insertHtml(editor, range, QUESTION_HTML.tf),
    },
    {
      title: 'Fill in the blank', description: 'A cloze question.', searchTerms: ['question', 'fill', 'blank', 'cloze'],
      icon: <Braces size={18} />,
      command: ({ editor, range }) => insertHtml(editor, range, QUESTION_HTML.fill),
    },
    {
      title: 'Match the following', description: 'Drag-and-drop matching question.', searchTerms: ['question', 'match', 'drag'],
      icon: <ArrowLeftRight size={18} />,
      command: ({ editor, range }) => insertNode(editor, range, 'match', MATCH_DEFAULT),
    },

    // ---- Advanced: media & tools (fire a window event the studio handles) ----
    {
      title: 'Image', description: 'Upload an image from your device.', searchTerms: ['image', 'picture', 'photo', 'upload'],
      icon: <ImageIcon size={18} />,
      command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); fireTool('image', range.from) },
    },
    {
      title: 'Video', description: 'Embed a YouTube video by URL.', searchTerms: ['video', 'youtube', 'embed', 'media'],
      icon: <Youtube size={18} />,
      command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); fireTool('video') },
    },
    {
      title: 'Solver', description: 'Run a query; pin the answer.', searchTerms: ['wolfram', 'solver', 'solve', 'compute', 'alpha'],
      icon: <Bot size={18} />,
      command: ({ editor, range }) => insertNode(editor, range, 'wolfram', SOLVER_DEFAULT),
    },
    {
      title: 'Python notebook', description: 'Author a runnable notebook instead.', searchTerms: ['python', 'notebook', 'code', 'jupyter'],
      icon: <NotebookPen size={18} />,
      command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); fireTool('python') },
    },
  ])

/** The slash extension for the document studio. */
export const documentSlashCommand = Command.configure({
  suggestion: { items: () => documentSlashItems, render: renderItems },
})

// ─────────────────────────────────────────────────────────────────────────────
// Shared insert catalogue — the single source of truth for BOTH the slash (/) menu
// and the left palette, so the two surfaces stay in lockstep (same items, same
// grouping, same tint). Categories read at a glance; the tint keys off the category.
// ─────────────────────────────────────────────────────────────────────────────

export type InsertCategory = 'Basic' | 'Media' | 'Math & data' | 'Questions'

/** Category order as it appears in both the slash menu and the palette. */
export const INSERT_CATEGORIES: InsertCategory[] = ['Basic', 'Media', 'Math & data', 'Questions']

const CATEGORY_OF: Record<string, InsertCategory> = {
  'Text': 'Basic', 'Heading 1': 'Basic', 'Heading 2': 'Basic', 'Heading 3': 'Basic',
  'Bullet List': 'Basic', 'Numbered List': 'Basic', 'To-do List': 'Basic', 'Quote': 'Basic',
  'Callout': 'Basic', 'Code': 'Basic', 'Toggle': 'Basic', 'Divider': 'Basic',
  'Image': 'Media', 'Video': 'Media', 'Table': 'Media',
  'Equation': 'Math & data', 'LaTeX': 'Math & data', 'Chemistry': 'Math & data', 'Chart': 'Math & data',
  'Map': 'Math & data', 'Solver': 'Math & data', 'Python notebook': 'Math & data',
  'Multiple choice': 'Questions', 'Short answer': 'Questions', 'True or False': 'Questions',
  'Fill in the blank': 'Questions', 'Match the following': 'Questions',
}

/** Chart-token tint per category (matches the four slash-menu colors). */
export const CATEGORY_CHART: Record<InsertCategory, number> = {
  'Basic': 1, 'Media': 4, 'Math & data': 2, 'Questions': 3,
}

export const insertCategoryOf = (title: string): InsertCategory => CATEGORY_OF[title] ?? 'Basic'

export type SlashItem = (typeof documentSlashItems)[number]

/** documentSlashItems bucketed by category, in category order (empty buckets dropped). */
export function groupedDocumentSlashItems(): { category: InsertCategory; items: SlashItem[] }[] {
  return INSERT_CATEGORIES
    .map((category) => ({ category, items: documentSlashItems.filter((it) => insertCategoryOf(it.title ?? '') === category) }))
    .filter((g) => g.items.length > 0)
}
