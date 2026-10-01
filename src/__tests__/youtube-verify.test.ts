import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `verifyYoutubeVideo` — the only check that can catch a FABRICATED-but-well-formed video id.
 *
 * A live probe caught Athena grounding a real lesson's existence on toptechboy.com, getting no
 * YouTube URL from search, and emitting `watch?v=pD4UqjS3W2A` — which oEmbed 404s. That id passes
 * every offline test, and YouTube renders the failure INSIDE a cross-origin iframe we cannot
 * inspect, so the professor just sees a dead player over a chip that said "Added 3 blocks".
 *
 * Two properties are load-bearing here and both are asserted:
 *  1. It is NOT an open fetch proxy. It takes an ID, never a URL, and rebuilds the request
 *     server-side — so no caller can steer it at an internal host.
 *  2. "We could not find out" is NEVER reported as "it does not exist". A false accusation on a
 *     professor's own link would make the whole signal untrustworthy, so only an explicit 404/400
 *     produces `missing`.
 */

const getUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: getUser } }),
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const { verifyYoutubeVideo } = await import('@/components/professor/assignments/studio/actions')

const SIGNED_IN = { data: { user: { id: 'prof-1' } } }

describe('verifyYoutubeVideo', () => {
  beforeEach(() => {
    getUser.mockResolvedValue(SIGNED_IN)
  })

  it('reports a real video as ok, with its title', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ title: 'Making Sense of NMEA 0183 Sentences', author_name: "Robert's Smorgasbord" }),
    })
    vi.stubGlobal('fetch', fetchMock)

    // A real id from the probe.
    await expect(verifyYoutubeVideo('aLeCaa7TUZA')).resolves.toEqual({
      status: 'ok',
      title: 'Making Sense of NMEA 0183 Sentences',
      author: "Robert's Smorgasbord",
    })

    // Property 1: the request is built from the id, and only ever points at youtube.com.
    const url = String(fetchMock.mock.calls[0][0])
    expect(url.startsWith('https://www.youtube.com/oembed?')).toBe(true)
    expect(url).toContain('aLeCaa7TUZA')
  })

  it('reports the FABRICATED id from the probe as missing on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }))
    await expect(verifyYoutubeVideo('pD4UqjS3W2A')).resolves.toEqual({ status: 'missing' })
  })

  it.each([500, 429, 403])('does NOT claim missing on a %d — that is unknown', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) }))
    // Distinct id per case so the module cache can't answer for us.
    await expect(verifyYoutubeVideo(`x${status}aaaaaaa`.slice(0, 11))).resolves.toEqual({ status: 'unknown' })
  })

  it('does NOT claim missing when the network throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    await expect(verifyYoutubeVideo('netfail1234')).resolves.toEqual({ status: 'unknown' })
  })

  it('refuses to fetch at all for anything that is not a valid id — no SSRF surface', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // Each of these would be an attempt to steer the request somewhere else.
    for (const bad of [
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      '../../etc/passwd',
      'short',
      '',
    ]) {
      await expect(verifyYoutubeVideo(bad)).resolves.toEqual({ status: 'missing' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('strips anything trailing the id rather than passing it through', async () => {
    // A real watch URL carries extra params (&t=, &list=), so trailing junk must NORMALISE to
    // the id, not be rejected — and critically, must not survive into the outbound request.
    // `&url=` is the interesting one: oEmbed takes a `url` param, so a second one leaking
    // through would be the actual injection.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ title: 'Real video', author_name: null }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyYoutubeVideo('bbbbbbbbbbb&url=http://internal')).resolves.toMatchObject({
      status: 'ok',
    })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).not.toContain('internal')
    // Exactly one url param, and it is the one we built.
    expect(url.match(/[?&]url=/g)).toHaveLength(1)
    expect(url).toContain(encodeURIComponent('https://www.youtube.com/watch?v=bbbbbbbbbbb'))
  })

  it('does not call out at all when the caller is not signed in', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyYoutubeVideo('aLeCaa7TUZA')).resolves.toEqual({ status: 'unknown' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
