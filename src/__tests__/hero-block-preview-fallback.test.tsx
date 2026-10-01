// HeroBlockPreview default-banner fallback (issue #527 follow-up).
// The hero always renders image-led: the professor's upload when present,
// otherwise the bundled default asset with empty (decorative) alt text.

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  HeroBlockPreview,
  DEFAULT_BANNER_SRC,
} from '@/components/professor/about/blocks/previews/HeroBlockPreview'
import type { HeroBlock } from '@/lib/validations/course-about'

function buildHero(overrides: Partial<HeroBlock['data']> = {}): HeroBlock {
  return {
    id: 'h-1',
    type: 'hero',
    data: {
      bannerSrc: '',
      bannerAlt: '',
      title: 'Data Structures',
      subtitle: 'CS201',
      instructor: '',
      semester: '',
      credits: '',
      introVideoUrl: '',
      ctaText: '',
      ctaUrl: '',
      ...overrides,
    },
  }
}

describe('HeroBlockPreview banner fallback', () => {
  it('renders the bundled default banner with empty alt when no image is uploaded', () => {
    const { container } = render(<HeroBlockPreview block={buildHero()} />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(DEFAULT_BANNER_SRC)
    expect(img!.getAttribute('alt')).toBe('')
  })

  it('renders the professor upload with their alt text when an image is set', () => {
    const { container } = render(
      <HeroBlockPreview
        block={buildHero({ bannerSrc: 'https://x.co/banner.jpg', bannerAlt: 'Campus quad' })}
      />
    )
    const img = container.querySelector('img')
    expect(img!.getAttribute('src')).toBe('https://x.co/banner.jpg')
    expect(img!.getAttribute('alt')).toBe('Campus quad')
  })

  it('renders nothing when the hero has no title, subtitle, or upload', () => {
    const { container } = render(
      <HeroBlockPreview block={buildHero({ title: '', subtitle: '' })} />
    )
    expect(container.querySelector('img')).toBeNull()
  })
})
