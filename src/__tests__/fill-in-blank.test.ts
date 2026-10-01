import { describe, it, expect } from 'vitest'
import {
  sanitizeBlankAnswer,
  serializeBlankToken,
  hasInlineBlanks,
  stripBlankAnswers,
  segmentFillInBlankText,
  parseBlanks,
  blankIds,
  inlineBlankCount,
  blankPlaceholderText,
  newBlankId,
} from '@/lib/quiz/fill-in-blank'

describe('serializeBlankToken', () => {
  it('emits id + pipe-joined answers', () => {
    expect(serializeBlankToken('b1', ['mitochondria', 'mito'])).toBe('{{blank:b1:mitochondria|mito}}')
  })
  it('emits positional-only when there are no answers', () => {
    expect(serializeBlankToken('b1', [])).toBe('{{blank:b1}}')
    expect(serializeBlankToken('b1', ['', '  '])).toBe('{{blank:b1}}')
  })
  it('sanitizes brace/pipe chars out of answers so the token can never break', () => {
    expect(serializeBlankToken('b1', ['a}b', 'c|d', '{e}'])).toBe('{{blank:b1:ab|cd|e}}')
  })
})

describe('sanitizeBlankAnswer', () => {
  it('strips { } | and trims', () => {
    expect(sanitizeBlankAnswer('  a{b}|c  ')).toBe('abc')
    expect(sanitizeBlankAnswer('New Delhi')).toBe('New Delhi')
  })
})

describe('hasInlineBlanks', () => {
  it('detects canonical and stripped tokens', () => {
    expect(hasInlineBlanks('The {{blank:b1:x}} is here.')).toBe(true)
    expect(hasInlineBlanks('The {{blank:b1}} is here.')).toBe(true)
  })
  it('is false for legacy underscore text and plain prose', () => {
    expect(hasInlineBlanks('The _____ is here.')).toBe(false)
    expect(hasInlineBlanks('No blanks at all.')).toBe(false)
    expect(hasInlineBlanks('')).toBe(false)
  })
  it('is not fooled by LaTeX braces', () => {
    expect(hasInlineBlanks('The value $\\frac{a}{b}$ and set $\\{1,2\\}$.')).toBe(false)
  })
})

describe('stripBlankAnswers — the anti-leak gate', () => {
  it('removes the answer payload, keeping positional tokens', () => {
    expect(stripBlankAnswers('The {{blank:b1:mitochondria|mito}} produces {{blank:b2:ATP}}.'))
      .toBe('The {{blank:b1}} produces {{blank:b2}}.')
  })
  it('leaves NO trace of any accepted answer in the output', () => {
    const answers = ['photosynthesis', 'Krebs cycle', 'deoxyribonucleic acid', 'H2O', 'π']
    const text = `A ${serializeBlankToken('a', [answers[0], answers[1]])} B ${serializeBlankToken('b', [answers[2]])} C ${serializeBlankToken('c', [answers[3], answers[4]])}`
    const stripped = stripBlankAnswers(text)
    for (const a of answers) expect(stripped.includes(a)).toBe(false)
    expect(stripped).toBe('A {{blank:a}} B {{blank:b}} C {{blank:c}}')
  })
  it('is idempotent — stripping already-stripped text changes nothing', () => {
    const once = stripBlankAnswers('x {{blank:b1:secret}} y')
    expect(stripBlankAnswers(once)).toBe(once)
    expect(once).toBe('x {{blank:b1}} y')
  })
  it('handles adjacent tokens and tokens at the very start/end', () => {
    expect(stripBlankAnswers('{{blank:a:one}}{{blank:b:two}}')).toBe('{{blank:a}}{{blank:b}}')
  })
  it('preserves answers that contain colons or spaces up to the terminator', () => {
    // "3:4" is a single answer; strip must still remove it entirely
    const text = serializeBlankToken('r', ['3:4', 'three to four'])
    expect(text).toBe('{{blank:r:3:4|three to four}}')
    expect(stripBlankAnswers(text)).toBe('{{blank:r}}')
  })
  it('leaves legacy text and LaTeX untouched', () => {
    expect(stripBlankAnswers('The _____ is here.')).toBe('The _____ is here.')
    expect(stripBlankAnswers('Set $\\{1,2\\}$ and $\\frac{a}{b}$.')).toBe('Set $\\{1,2\\}$ and $\\frac{a}{b}$.')
  })
})

describe('segmentFillInBlankText', () => {
  it('splits prose and blanks in order with correct indices', () => {
    const segs = segmentFillInBlankText('The {{blank:b1:mito}} makes {{blank:b2:ATP}}.')
    expect(segs).toEqual([
      { type: 'text', value: 'The ' },
      { type: 'blank', id: 'b1', index: 0, acceptedAnswers: ['mito'] },
      { type: 'text', value: ' makes ' },
      { type: 'blank', id: 'b2', index: 1, acceptedAnswers: ['ATP'] },
      { type: 'text', value: '.' },
    ])
  })
  it('yields blanks with empty answers for stripped (student) text', () => {
    const segs = segmentFillInBlankText('The {{blank:b1}} makes {{blank:b2}}.')
    expect(segs.filter((s) => s.type === 'blank')).toEqual([
      { type: 'blank', id: 'b1', index: 0, acceptedAnswers: [] },
      { type: 'blank', id: 'b2', index: 1, acceptedAnswers: [] },
    ])
  })
  it('returns a single text segment when there are no blanks', () => {
    expect(segmentFillInBlankText('Just prose.')).toEqual([{ type: 'text', value: 'Just prose.' }])
    expect(segmentFillInBlankText('')).toEqual([])
  })
})

describe('parseBlanks / blankIds / inlineBlankCount', () => {
  it('derives the blanks array in order', () => {
    expect(parseBlanks('a {{blank:x:one|uno}} b {{blank:y:two}}')).toEqual([
      { id: 'x', acceptedAnswers: ['one', 'uno'] },
      { id: 'y', acceptedAnswers: ['two'] },
    ])
  })
  it('de-duplicates repeated ids (first occurrence wins)', () => {
    expect(parseBlanks('{{blank:x:one}} and again {{blank:x:two}}')).toEqual([
      { id: 'x', acceptedAnswers: ['one'] },
    ])
    expect(inlineBlankCount('{{blank:x:one}} {{blank:x:two}}')).toBe(1)
  })
  it('exposes ids in order and a count', () => {
    expect(blankIds('{{blank:a:1}} {{blank:b:2}} {{blank:c:3}}')).toEqual(['a', 'b', 'c'])
    expect(inlineBlankCount('The _____ (legacy)')).toBe(0)
  })
})

describe('blankPlaceholderText', () => {
  it('replaces canonical + stripped tokens with _____ and hides answers', () => {
    expect(blankPlaceholderText('The {{blank:b1:mitochondria|mito}} makes {{blank:b2:ATP}}.'))
      .toBe('The _____ makes _____.')
    expect(blankPlaceholderText('The {{blank:b1}} makes {{blank:b2}}.')).toBe('The _____ makes _____.')
  })
  it('never leaks an answer into the placeholder form', () => {
    const t = `A ${serializeBlankToken('a', ['secret-answer'])} B`
    expect(blankPlaceholderText(t)).toBe('A _____ B')
    expect(blankPlaceholderText(t)).not.toContain('secret')
  })
  it('supports a custom placeholder and leaves non-blank text alone', () => {
    expect(blankPlaceholderText('{{blank:a:x}}', '▢')).toBe('▢')
    expect(blankPlaceholderText('no blanks here')).toBe('no blanks here')
    expect(blankPlaceholderText('')).toBe('')
  })
})

describe('newBlankId', () => {
  it('is unique across calls and token-safe', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newBlankId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('round-trip: serialize → strip → segment (student view keeps positions, loses answers)', () => {
  it('a student can reconstruct where blanks go but never their answers', () => {
    const authored = `Water is ${serializeBlankToken('h', ['H2O', 'water'])} and salt is ${serializeBlankToken('s', ['NaCl'])}.`
    const studentText = stripBlankAnswers(authored)
    const segs = segmentFillInBlankText(studentText)
    // positions preserved
    expect(segs.filter((s) => s.type === 'blank').map((s) => (s as { id: string }).id)).toEqual(['h', 's'])
    // answers gone
    expect(studentText).not.toMatch(/H2O|water|NaCl/)
    // and blanks[] derived from student text carry no answers
    expect(parseBlanks(studentText)).toEqual([
      { id: 'h', acceptedAnswers: [] },
      { id: 's', acceptedAnswers: [] },
    ])
  })
})
