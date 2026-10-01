/**
 * QuizCodeBlock — renders code snippets for quiz questions.
 * When language is 'latex', renders the content as formatted math via MarkdownLatex.
 * Otherwise displays a monospace code block with a language badge.
 */

import { Badge } from '@/components/ui/badge'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'

interface QuizCodeBlockProps {
  language: string
  code: string
}

export function QuizCodeBlock({ language, code }: QuizCodeBlockProps) {
  // Render LaTeX content as formatted math instead of raw code
  if (language === 'latex') {
    return (
      <div className="relative group">
        <div className="absolute top-3 right-3 z-10 opacity-60 group-hover:opacity-100 transition-opacity">
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wider font-semibold">
            {language}
          </Badge>
        </div>
        <div className="bg-muted/50 rounded-lg border p-4 pt-10 overflow-x-auto">
          <MarkdownLatex content={`$$${code}$$`} className="text-sm" />
        </div>
      </div>
    )
  }

  return (
    <div className="relative group">
      <div className="absolute top-3 right-3 z-10 opacity-60 group-hover:opacity-100 transition-opacity">
        <Badge variant="secondary" className="text-[10px] uppercase tracking-wider font-semibold">
          {language}
        </Badge>
      </div>
      <pre className="bg-muted/50 rounded-lg border p-4 pt-10 overflow-x-auto font-mono text-sm leading-relaxed text-foreground/90">
        <code>{code}</code>
      </pre>
    </div>
  )
}
