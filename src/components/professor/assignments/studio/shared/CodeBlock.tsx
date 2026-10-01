/**
 * Shared, DISPLAY-ONLY code highlighter — no dependency, no execution.
 *
 * A small built-in tokenizer (comments / strings / numbers / keywords) covering the
 * common languages. Themed with semantic tokens only. Used by the notebook (preview),
 * by StudioMarkdown for fenced code, and inherited by every template via the shell.
 */
'use client'

import { useMemo } from 'react'
import { cn } from '@/lib/utils'

type TokType = 'comment' | 'string' | 'number' | 'keyword' | 'plain'
interface Tok { t: TokType; v: string }

const KEYWORDS: Record<string, Set<string>> = {
  python: new Set(['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'import', 'from', 'as', 'class', 'try', 'except', 'finally', 'with', 'lambda', 'yield', 'pass', 'break', 'continue', 'raise', 'and', 'or', 'not', 'is', 'None', 'True', 'False', 'global', 'nonlocal', 'assert', 'del', 'await', 'async']),
  javascript: new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends', 'super', 'this', 'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'null', 'undefined', 'true', 'false', 'void', 'yield']),
  json: new Set(['true', 'false', 'null']),
  bash: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'in', 'return', 'export', 'local', 'echo', 'cd', 'source']),
}
KEYWORDS.typescript = new Set([...KEYWORDS.javascript, 'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly', 'as', 'namespace'])
KEYWORDS.ts = KEYWORDS.typescript
KEYWORDS.js = KEYWORDS.javascript
KEYWORDS.py = KEYWORDS.python
KEYWORDS.sh = KEYWORDS.bash
KEYWORDS.shell = KEYWORDS.bash
KEYWORDS.default = new Set([...KEYWORDS.python, ...KEYWORDS.javascript])

function tokenize(code: string, lang: string): Tok[] {
  const kw = KEYWORDS[lang] ?? KEYWORDS.default
  const hash = lang === 'python' || lang === 'py' || lang === 'bash' || lang === 'sh' || lang === 'shell'
  const lineComment = hash ? '#' : '//'
  const toks: Tok[] = []
  let i = 0
  const n = code.length
  const push = (t: TokType, v: string) => { if (v) toks.push({ t, v }) }

  while (i < n) {
    const rest = code.slice(i)
    let m: RegExpExecArray | null

    // Triple-quoted strings (Python).
    if ((m = /^("""[\s\S]*?"""|'''[\s\S]*?''')/.exec(rest))) { push('string', m[0]); i += m[0].length; continue }
    // Block comment (C-style languages).
    if (!hash && rest.startsWith('/*')) {
      const end = code.indexOf('*/', i + 2)
      const seg = end === -1 ? rest : code.slice(i, end + 2)
      push('comment', seg); i += seg.length; continue
    }
    // Line comment.
    if (rest.startsWith(lineComment)) {
      const nl = code.indexOf('\n', i)
      const seg = nl === -1 ? rest : code.slice(i, nl)
      push('comment', seg); i += seg.length; continue
    }
    // Strings.
    const ch = code[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const re = new RegExp('^' + ch + '(?:\\\\.|[^' + ch + '\\\\])*' + ch)
      const sm = re.exec(rest)
      if (sm) { push('string', sm[0]); i += sm[0].length; continue }
      push('string', rest); i = n; continue
    }
    // Numbers.
    if ((m = /^(0[xX][0-9a-fA-F]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)/.exec(rest))) { push('number', m[0]); i += m[0].length; continue }
    // Identifiers → keyword or plain.
    if ((m = /^[A-Za-z_$]\w*/.exec(rest))) { push(kw.has(m[0]) ? 'keyword' : 'plain', m[0]); i += m[0].length; continue }
    // Whitespace / punctuation runs (keep token count low).
    if ((m = /^[^\w"'`#/]+/.exec(rest))) { push('plain', m[0]); i += m[0].length; continue }
    push('plain', code[i]); i += 1
  }
  return toks
}

const TOK_CLASS: Record<TokType, string> = {
  comment: 'text-muted-foreground italic',
  string: 'text-success-muted-foreground',
  number: 'text-info-muted-foreground',
  keyword: 'text-primary font-medium',
  plain: '',
}

export function CodeBlock({
  code, language, className,
}: {
  code: string; language?: string; className?: string
}) {
  const toks = useMemo(() => tokenize(code, (language ?? '').toLowerCase()), [code, language])
  return (
    <pre className={cn('overflow-x-auto rounded-xl border border-border bg-muted/40 p-3 font-mono text-sm', className)}>
      <code>
        {toks.map((t, i) => (
          <span key={i} className={TOK_CLASS[t.t]}>{t.v}</span>
        ))}
      </code>
    </pre>
  )
}
