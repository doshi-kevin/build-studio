import { describe, it, expect } from 'vitest'
import { insertAt, wrapAt, linePrefixAt, imageMarkdown } from '@/lib/assignments/studio/insert-ops'

describe('studio insert-ops', () => {
  it('insertAt splices text and puts the cursor after it', () => {
    const r = insertAt('abcd', 2, 2, 'XY')
    expect(r.value).toBe('abXYcd')
    expect([r.selStart, r.selEnd]).toEqual([4, 4])
  })

  it('insertAt replaces a selection', () => {
    const r = insertAt('abcd', 1, 3, 'X')
    expect(r.value).toBe('aXd')
  })

  it('wrapAt wraps a selection and re-selects the inner text', () => {
    const r = wrapAt('hello world', 6, 11, '**', '**')
    expect(r.value).toBe('hello **world**')
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('world')
  })

  it('wrapAt with no selection inserts the placeholder, selected', () => {
    const r = wrapAt('x', 1, 1, '$', '$', 'eqn')
    expect(r.value).toBe('x$eqn$')
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('eqn')
  })

  it('linePrefixAt prepends at the start of the current line', () => {
    const r = linePrefixAt('line one\nline two', 12, '## ')
    expect(r.value).toBe('line one\n## line two')
  })

  it('linePrefixAt works on the first line', () => {
    const r = linePrefixAt('title', 2, '# ')
    expect(r.value).toBe('# title')
  })

  it('imageMarkdown derives alt from the filename and drops the extension', () => {
    expect(imageMarkdown('sales_chart_q3.png', 'https://cdn/x.png'))
      .toBe('![sales chart q3](https://cdn/x.png)')
  })

  it('imageMarkdown falls back to "Image" for a blank base name', () => {
    expect(imageMarkdown('.png', 'https://cdn/x.png')).toBe('![Image](https://cdn/x.png)')
  })

  it('imageMarkdown strips "]" so the alt cannot break the markdown syntax', () => {
    expect(imageMarkdown('a]b.png', 'https://cdn/x.png')).toBe('![ab](https://cdn/x.png)')
  })
})
