// Unit tests for the shared module-item URL-classification helpers. These run on
// every keystroke in the reference/video inputs (badges + stored metadata) and
// at roadmap render (link-vs-reference node choice), so a wrong regex
// misclassifies without any visible error. Pattern 4 (pure logic).

import { describe, it, expect } from 'vitest'
import {
  detectVideoProvider,
  detectReferenceType,
  extractVenue,
} from '@/lib/modules/url-classify'

describe('detectVideoProvider', () => {
  it('detects YouTube (watch + short link, any case)', () => {
    expect(detectVideoProvider('https://www.youtube.com/watch?v=abc123')).toBe('youtube')
    expect(detectVideoProvider('https://youtu.be/abc123')).toBe('youtube')
    expect(detectVideoProvider('HTTPS://YOUTUBE.COM/watch?v=x')).toBe('youtube')
  })

  it('detects Vimeo', () => {
    expect(detectVideoProvider('https://vimeo.com/123456789')).toBe('vimeo')
  })

  it('falls back to "link" for any other host', () => {
    expect(detectVideoProvider('https://example.com/lecture.mp4')).toBe('link')
    expect(detectVideoProvider('')).toBe('link')
  })
})

describe('detectReferenceType', () => {
  it('classifies academic-paper hosts as "paper"', () => {
    expect(detectReferenceType('https://arxiv.org/abs/1706.03762')).toBe('paper')
    expect(detectReferenceType('https://doi.org/10.1145/3292500.3330701')).toBe('paper')
    expect(detectReferenceType('https://aclanthology.org/N19-1423/')).toBe('paper')
    expect(detectReferenceType('https://openreview.net/forum?id=abc')).toBe('paper')
  })

  it('classifies blog / long-form hosts as "reading"', () => {
    expect(detectReferenceType('https://medium.com/@x/some-post')).toBe('reading')
    expect(detectReferenceType('https://distill.pub/2016/misread-tsne/')).toBe('reading')
    expect(detectReferenceType('https://someuser.github.io/notes/')).toBe('reading')
  })

  it('falls back to "link" for a plain URL', () => {
    expect(detectReferenceType('https://example.com/resource')).toBe('link')
    expect(detectReferenceType('')).toBe('link')
  })

  it('prefers "paper" over "reading" when a host matches both patterns first', () => {
    // arXiv is a paper host; a paper match should win the ordering.
    expect(detectReferenceType('https://arxiv.org/abs/2001.00001')).toBe('paper')
  })
})

describe('extractVenue', () => {
  it('extracts the arXiv id from abs and pdf URLs', () => {
    expect(extractVenue('https://arxiv.org/abs/1706.03762')).toEqual({ venue: 'arXiv', venueId: '1706.03762' })
    expect(extractVenue('https://arxiv.org/pdf/2005.14165')).toEqual({ venue: 'arXiv', venueId: '2005.14165' })
  })

  it('extracts the DOI identifier', () => {
    expect(extractVenue('https://doi.org/10.1145/3292500.3330701')).toEqual({
      venue: 'DOI',
      venueId: '10.1145/3292500.3330701',
    })
  })

  it('stops the DOI id at a query string or fragment', () => {
    expect(extractVenue('https://doi.org/10.1000/xyz?utm=1')).toEqual({ venue: 'DOI', venueId: '10.1000/xyz' })
  })

  it('returns a friendly venue name (no id) for known hosts', () => {
    expect(extractVenue('https://ieeexplore.ieee.org/document/8765432')).toEqual({ venue: 'IEEE' })
    expect(extractVenue('https://papers.nips.cc/paper/1234')).toEqual({ venue: 'NeurIPS' })
    expect(extractVenue('https://aclanthology.org/N19-1423/')).toEqual({ venue: 'ACL Anthology' })
  })

  it('returns null for a URL with no recognizable venue', () => {
    expect(extractVenue('https://example.com/paper.pdf')).toBeNull()
    expect(extractVenue('')).toBeNull()
  })
})
