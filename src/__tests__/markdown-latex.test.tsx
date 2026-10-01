// Tests for the MarkdownLatex shared component
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'

describe('MarkdownLatex', () => {
  describe('default variant', () => {
    it('renders plain text', () => {
      render(<MarkdownLatex content="What is 2 + 2?" />)
      expect(screen.getByText('What is 2 + 2?')).toBeInTheDocument()
    })

    it('renders markdown bold text', () => {
      render(<MarkdownLatex content="This is **bold** text" />)
      const bold = screen.getByText('bold')
      expect(bold.tagName).toBe('STRONG')
    })

    it('renders markdown italic text', () => {
      render(<MarkdownLatex content="This is *italic* text" />)
      const italic = screen.getByText('italic')
      expect(italic.tagName).toBe('EM')
    })

    it('renders inline code', () => {
      render(<MarkdownLatex content="Use `console.log()` for debugging" />)
      const code = screen.getByText('console.log()')
      expect(code.tagName).toBe('CODE')
    })

    it('renders a list', () => {
      const listContent = `- Item A
- Item B
- Item C`
      render(<MarkdownLatex content={listContent} />)
      expect(screen.getByText('Item A')).toBeInTheDocument()
      expect(screen.getByText('Item B')).toBeInTheDocument()
      expect(screen.getByText('Item C')).toBeInTheDocument()
    })

    it('renders LaTeX inline math', () => {
      const { container } = render(<MarkdownLatex content="The formula is $E = mc^2$" />)
      // KaTeX renders into .katex elements
      const katexEl = container.querySelector('.katex')
      expect(katexEl).toBeInTheDocument()
    })

    it('renders LaTeX block math', () => {
      const blockContent = `$$
\\frac{a}{b} = c
$$`
      const { container } = render(
        <MarkdownLatex content={blockContent} />,
      )
      // Block math wraps in a .katex element (display mode may vary by renderer)
      const katexEl = container.querySelector('.katex')
      expect(katexEl).toBeInTheDocument()
    })

    it('returns null for empty content', () => {
      const { container } = render(<MarkdownLatex content="" />)
      expect(container.innerHTML).toBe('')
    })

    it('applies custom className', () => {
      const { container } = render(
        <MarkdownLatex content="Hello" className="text-lg my-custom" />,
      )
      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain('my-custom')
    })

    it('has prose class for typography', () => {
      const { container } = render(<MarkdownLatex content="Hello" />)
      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain('prose')
    })
  })

  describe('inline variant', () => {
    it('renders as a span element', () => {
      const { container } = render(
        <MarkdownLatex content="Hello world" variant="inline" />,
      )
      const el = container.firstChild as HTMLElement
      expect(el.tagName).toBe('SPAN')
    })

    it('strips markdown characters for clean truncation', () => {
      render(
        <MarkdownLatex content="What is **bold** and *italic*?" variant="inline" />,
      )
      // Should strip *, but keep text
      expect(screen.getByText(/What is bold and italic/)).toBeInTheDocument()
    })

    it('strips heading markers', () => {
      render(<MarkdownLatex content="## Heading text" variant="inline" />)
      expect(screen.getByText(/Heading text/)).toBeInTheDocument()
    })

    it('has line-clamp-1 class', () => {
      const { container } = render(
        <MarkdownLatex content="Some text" variant="inline" />,
      )
      const el = container.firstChild as HTMLElement
      expect(el.className).toContain('line-clamp-1')
    })

    it('applies custom className', () => {
      const { container } = render(
        <MarkdownLatex content="Text" variant="inline" className="text-sm flex-1" />,
      )
      const el = container.firstChild as HTMLElement
      expect(el.className).toContain('flex-1')
    })
  })
})
