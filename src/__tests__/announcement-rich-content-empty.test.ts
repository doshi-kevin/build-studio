/**
 * #669 part 5 — the "no body text" fallbacks could never render. Clearing all text in
 * the editor leaves ONE empty paragraph node, so `content.content?.length` is 1 and
 * truthy: three surfaces tested node COUNT and therefore rendered an empty block instead
 * of their intended message.
 *
 * Both directions matter. Too eager and a body whose whole point is an image gets
 * replaced by "This announcement has no body text" — hiding real content, which is worse
 * than the bug. The void-node cases below are that guard.
 */

import { describe, it, expect } from 'vitest'
import { isRichContentEmpty } from '@/lib/announcements/rich-content'
import type { JSONContent } from 'novel'

const doc = (content: unknown[]): JSONContent => ({ type: 'doc', content } as JSONContent)
const para = (text?: string) =>
  text === undefined ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text }] }

describe('isRichContentEmpty', () => {
  it('treats the cleared editor as empty — the exact case that broke', () => {
    // One empty paragraph: length 1, truthy, which is why the old test failed.
    const cleared = doc([para()])
    expect(cleared.content).toHaveLength(1)
    expect(isRichContentEmpty(cleared)).toBe(true)
  })

  it('treats whitespace-only text as empty', () => {
    expect(isRichContentEmpty(doc([para('   ')]))).toBe(true)
    expect(isRichContentEmpty(doc([para('\n\t ')]))).toBe(true)
  })

  it('treats several empty paragraphs as empty', () => {
    expect(isRichContentEmpty(doc([para(), para(), para('')]))).toBe(true)
  })

  it('treats null / undefined / no nodes as empty', () => {
    expect(isRichContentEmpty(null)).toBe(true)
    expect(isRichContentEmpty(undefined)).toBe(true)
    expect(isRichContentEmpty(doc([]))).toBe(true)
  })

  it('does NOT treat real text as empty', () => {
    expect(isRichContentEmpty(doc([para('Midterm moved to Friday.')]))).toBe(false)
  })

  it('does NOT treat an image-only body as empty', () => {
    // The false positive that matters: hiding a body whose point IS the image.
    expect(isRichContentEmpty(doc([{ type: 'image', attrs: { src: 'x.png' } }]))).toBe(false)
  })

  it('does NOT treat a course mention or embed as empty', () => {
    expect(isRichContentEmpty(doc([{ type: 'courseMention', attrs: { id: 'a1' } }]))).toBe(false)
    expect(isRichContentEmpty(doc([{ type: 'youtube', attrs: { src: 'v' } }]))).toBe(false)
  })

  it('finds text nested inside lists and blockquotes', () => {
    const nested = doc([
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [para('Bring your laptop')] }],
      },
    ])
    expect(isRichContentEmpty(nested)).toBe(false)
  })

  it('treats a list of empty items as empty', () => {
    const hollow = doc([
      { type: 'bulletList', content: [{ type: 'listItem', content: [para()] }] },
    ])
    expect(isRichContentEmpty(hollow)).toBe(true)
  })
})
