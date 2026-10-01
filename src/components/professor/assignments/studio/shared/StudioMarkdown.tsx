/**
 * Shared rich-text renderer for the studio: Markdown + LaTeX math ($…$, $$…$$) + chemistry
 * (\ce{…} via KaTeX's mhchem — no new dependency) + display-only highlighted code blocks.
 *
 * Shell-level: every template renders prompts/instructions through this, so all templates
 * inherit live math, chemistry, and code highlighting. We do NOT modify the app-wide
 * MarkdownLatex; this is a studio-owned renderer that adds chemistry + fenced-code highlight.
 */
'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
// Side-effect: enables \ce{...} / \pu{...} chemistry in the shared KaTeX instance.
import 'katex/dist/contrib/mhchem.mjs'
import { cn } from '@/lib/utils'
import { CodeBlock } from './CodeBlock'

export function StudioMarkdown({ content, className }: { content: string; className?: string }) {
  if (!content) return null
  return (
    <div className={cn('markdown-latex prose prose-sm prose-neutral max-w-none', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        // Be forgiving: generated math (e.g. from the Solver) may not be perfect LaTeX; render it
        // in normal text colour instead of throwing or showing a red error.
        rehypePlugins={[[rehypeKatex, { throwOnError: false, errorColor: 'currentColor', strict: false }]]}
        components={{
          // Render markdown images by URL (a plain <img>, so any direct image URL works).
          // Only render a src that's a real, fetchable image URL: http(s), a data:image URI, or a
          // root-relative path. Anything else (an empty/stripped javascript: src, or the
          // "image-url" placeholder from the Image quick-insert) is passed as undefined — a bare
          // relative token like "image-url" would otherwise resolve against the current route and
          // make the browser re-download the whole page (the "refresh" the professor saw).
          img: ({ src, alt }) => {
            const safeSrc = typeof src === 'string' && /^(https?:\/\/|data:image\/|\/)/i.test(src) ? src : undefined
            // eslint-disable-next-line @next/next/no-img-element
            return <img src={safeSrc} alt={alt ?? ''} loading="lazy" className="max-w-full rounded-xl border border-border" />
          },
          // Unwrap the default <pre> so CodeBlock controls its own block element.
          pre: ({ children }) => <>{children}</>,
          code({ className: cls, children }) {
            const match = /language-(\w+)/.exec(cls ?? '')
            const text = String(children ?? '')
            // Inline code: no language fence and single line.
            if (!match && !text.includes('\n')) {
              return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
            }
            return <CodeBlock code={text.replace(/\n$/, '')} language={match?.[1]} />
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
