import { describe, it, expect } from 'vitest'

import { imageContentHash } from '@/lib/document-parser/pdf'

// Pins the dedup contract for issue #556: exact-duplicate images collapse,
// but anything that isn't byte-identical (different pixels, dimensions, or
// pixel kind) stays distinct. The whole design rejects perceptual/near-dup
// merging because it deletes real teaching frames, so the anti-collision
// guarantees below are the thing that keeps distinct content from being lost.

const img = (data: number[], width = 2, height = 2, kind = 3) => ({
  data: new Uint8Array(data),
  width,
  height,
  kind,
})

describe('imageContentHash', () => {
  it('gives identical images the same hash (exact duplicates collapse)', () => {
    const a = img([1, 2, 3, 4])
    const b = img([1, 2, 3, 4])
    expect(imageContentHash(a)).toBe(imageContentHash(b))
  })

  it('gives images with different pixels different hashes (distinct content kept)', () => {
    expect(imageContentHash(img([1, 2, 3, 4]))).not.toBe(
      imageContentHash(img([1, 2, 3, 5])),
    )
  })

  it('does not collide identical bytes across different dimensions', () => {
    // Same four bytes, but 2x2 vs 4x1 — must not be treated as the same image.
    expect(imageContentHash(img([1, 2, 3, 4], 2, 2))).not.toBe(
      imageContentHash(img([1, 2, 3, 4], 4, 1)),
    )
  })

  it('does not collide identical bytes across different pixel kinds', () => {
    expect(imageContentHash(img([1, 2, 3, 4], 2, 2, 3))).not.toBe(
      imageContentHash(img([1, 2, 3, 4], 2, 2, 1)),
    )
  })
})
