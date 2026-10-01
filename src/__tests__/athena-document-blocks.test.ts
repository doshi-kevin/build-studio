import { describe, it, expect } from 'vitest'
import { buildBlockNode } from '@/components/professor/assignments/studio/athena-document-blocks'

describe('buildBlockNode', () => {
  it('builds a callout with a valid variant + body text', () => {
    const n = buildBlockNode('callout', '{"variant":"warning"}', 'Be careful with edge cases.') as {
      type: string
      attrs: { variant: string }
      content: { type: string; content?: { text: string }[] }[]
    }
    expect(n.type).toBe('callout')
    expect(n.attrs.variant).toBe('warning')
    expect(n.content[0].content?.[0].text).toBe('Be careful with edge cases.')
  })

  it('defaults an unknown callout variant to info', () => {
    const n = buildBlockNode('callout', '{"variant":"nope"}', 'x') as { attrs: { variant: string } }
    expect(n.attrs.variant).toBe('info')
  })

  it('builds an equation from text (latex) and rejects an empty one', () => {
    const n = buildBlockNode('equation', undefined, 'E = mc^2') as { type: string; attrs: { latex: string } }
    expect(n.type).toBe('equation')
    expect(n.attrs.latex).toBe('E = mc^2')
    expect(buildBlockNode('equation', undefined, '   ')).toBeNull()
  })

  it('builds a chart, JSON-encoding the config into the data attr', () => {
    const n = buildBlockNode('chart', '{"type":"bar","title":"Scores","points":[{"x":"A","y":4},{"x":"B","y":7}]}', undefined) as {
      type: string
      attrs: { data: string }
    }
    expect(n.type).toBe('chart')
    const data = JSON.parse(n.attrs.data)
    expect(data.type).toBe('bar')
    expect(data.points).toHaveLength(2)
  })

  it('builds a match block and generates stable ids for pairs/distractors', () => {
    const n = buildBlockNode('match', '{"prompt":"Match","pairs":[{"left":"H2O","right":"Water"}],"distractors":[{"text":"Air"}]}', undefined) as {
      attrs: { data: string }
    }
    const data = JSON.parse(n.attrs.data)
    expect(data.pairs[0]).toMatchObject({ id: 'p1', left: 'H2O', right: 'Water' })
    expect(data.distractors[0]).toMatchObject({ id: 'd1', text: 'Air' })
  })

  it('builds image (needs a real http src) and youtube (src from text)', () => {
    expect(buildBlockNode('image', '{"src":"https://x/y.png","alt":"y"}', undefined)).toMatchObject({
      type: 'image',
      attrs: { src: 'https://x/y.png', alt: 'y' },
    })
    expect(buildBlockNode('image', '{}', undefined)).toBeNull() // no src
    // An 11-char id, because that is what a YouTube id IS. This assertion previously used
    // `watch?v=abc` and passed — encoding the bug: the builder accepted any non-empty string,
    // so Athena could insert a "video" the renderer could only draw as "Video unavailable"
    // while the summary reported it as added.
    expect(buildBlockNode('youtube', undefined, 'https://youtube.com/watch?v=aLeCaa7TUZA')).toMatchObject({
      type: 'youtube',
      attrs: { src: 'https://youtube.com/watch?v=aLeCaa7TUZA' },
    })
  })

  it('rejects block links the renderer could not embed', () => {
    // The builder must not be laxer than YoutubeNode — they now share youtubeVideoId.
    expect(buildBlockNode('youtube', undefined, 'https://youtube.com/watch?v=abc')).toBeNull()
    expect(buildBlockNode('youtube', undefined, 'a video about NMEA sentences')).toBeNull()
    expect(buildBlockNode('youtube', undefined, 'https://vimeo.com/123456789')).toBeNull()
    // Relative paths and placeholders became permanently-broken <img> tags.
    expect(buildBlockNode('image', '{"src":"/images/gps.png"}', undefined)).toBeNull()
    expect(buildBlockNode('image', '{"src":"[PLACEHOLDER]"}', undefined)).toBeNull()
  })

  it('returns null on malformed JSON and on an unknown block type', () => {
    expect(buildBlockNode('chart', '{not json', undefined)).toBeNull()
    expect(buildBlockNode('hologram', '{}', 'x')).toBeNull()
  })

  it('builds graph/map/wolfram with sensible defaults filled in', () => {
    expect(buildBlockNode('graph', '{"functions":[{"expr":"x^2"}]}', undefined)).toMatchObject({ type: 'graph' })
    expect(buildBlockNode('map', '{"markers":[{"lat":1,"lng":2,"label":"A"}]}', undefined)).toMatchObject({ type: 'map' })
    expect(buildBlockNode('wolfram', '{"query":"integrate x"}', undefined)).toMatchObject({ type: 'wolfram' })
  })
})
