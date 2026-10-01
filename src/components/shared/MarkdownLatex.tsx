// Renders question text with Markdown and LaTeX (KaTeX) support.
// Used in quiz player, review cards, insights dashboard, and submission pages.
// Variants:
//   'default' — full prose rendering with block-level markdown + LaTeX
//   'inline'  — plain text strip, no LaTeX (list previews / truncated labels)
//   'compact' — LaTeX + basic markdown rendered, no prose block styling (answer choices)
'use client'

import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import 'katex/dist/katex.min.css'
import { cn } from '@/lib/utils'
import { normalizeMathDelimiters } from '@/lib/markdown/math'

interface MarkdownLatexProps {
  content: string
  className?: string
  /**
   * - 'default'  Full prose block rendering with LaTeX (question stems, explanations)
   * - 'inline'   Plain-text strip with line-clamp (list previews, truncated labels)
   * - 'compact'  LaTeX + basic markdown, no prose wrapper (answer choice options)
   */
  variant?: 'default' | 'inline' | 'compact'
  /** The `compact` wrapper element. `span` for phrasing-only contexts — inside a
   *  <button> or a <span>, where a <div> is invalid nesting. */
  as?: 'div' | 'span'
}

export function MarkdownLatex({ content, className, variant = 'default', as = 'div' }: MarkdownLatexProps) {
  if (!content) return null

  if (variant === 'inline') {
    return (
      <span className={cn('line-clamp-1', className)}>
        {content.replace(/[*_`#>\[\]]/g, '')}
      </span>
    )
  }

  // `\(x\)` and stray dollar amounts reach here straight from an LLM — see
  // lib/markdown/math.ts for what the two shapes used to render as.
  const markdown = normalizeMathDelimiters(content)

  if (variant === 'compact') {
    const Wrapper = as
    return (
      <Wrapper className={cn('markdown-latex-compact [&_.katex]:text-[0.95em]', className)}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            // Suppress block-level wrappers so choices stay inline with flex layout
            p: ({ children }) => <span>{children}</span>,
            // Keep code monospace but unstyled
            code: ({ children }) => <code className="font-mono text-[0.9em]">{children}</code>,
          }}
        >
          {markdown}
        </ReactMarkdown>
      </Wrapper>
    )
  }

  return (
    <div className={cn('markdown-latex prose prose-sm prose-neutral max-w-none', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
