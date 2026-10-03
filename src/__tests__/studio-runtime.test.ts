/**
 * The Studio plugin runtime's server-side and pure pieces: the frame document and its
 * security policy, the two origins, the bridge envelope parser, signed frame tickets and
 * the frame route. Browser enforcement of all of this is tested in e2e/studio-runtime.
 */
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLE_ELEMENT_ID, frameCsp, frameHeaders, frameHtml, escapeScriptText } from '@/lib/studio/runtime/frame-document'
import { classifyRuntimeRequest, requestHost, studioOrigins } from '@/lib/studio/runtime/origin'
import { parseFrameMessage, parseRosterPayload } from '@/lib/studio/runtime/protocol'
import type { StudioViewer } from '@/lib/studio/context'

vi.mock('@/lib/studio/context', () => ({ resolveViewer: vi.fn(), candidateVersion: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({ loadVersionBundle: vi.fn() }))
vi.mock('@/lib/studio/access', () => ({ studioKillSwitchEngaged: vi.fn() }))

const { resolveViewer, candidateVersion } = await import('@/lib/studio/context')
const { loadVersionBundle } = await import('@/lib/studio/db')
const { studioKillSwitchEngaged } = await import('@/lib/studio/access')
const { signFrameTicket, verifyFrameTicket, issueFrameUrl } = await import('@/lib/studio/runtime/frame-ticket')
const { frameResponse } = await import('@/lib/studio/runtime/frame')

const APP = 'http://localhost:3000'
const RUNTIME = 'http://127.0.0.1:3000'
const SECRET = 'a-test-only-frame-ticket-secret-of-48-characters!!'
const NONCE = 'AAECAwQFBgcICQoLDA0ODxAR'
const INPUT = { appOrigin: APP, runtimeOrigin: RUNTIME, nonce: NONCE, bundle: 'ScholeraStudio.request("x")', title: 'Exit ticket', runtime: 'v1' as const }

const directives = (csp: string) => Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]))

describe('frame security policy', () => {
  const csp = directives(frameCsp(INPUT))

  it('denies by default and names every directive explicitly', () => {
    expect(csp).toEqual({
      'default-src': "'none'",
      // runtime.js, then Scholera's pinned vendor file (React and the kit), then the nonce'd bundle.
      'script-src': `${RUNTIME}/studio-runtime/v1/runtime.js ${RUNTIME}/studio-runtime/v1/vendor.js 'nonce-${NONCE}'`,
      'style-src': `${RUNTIME}/studio-runtime/v1/`,
      'font-src': `${RUNTIME}/studio-runtime/v1/fonts/`,
      'img-src': "'none'",
      'media-src': "'none'",
      'connect-src': "'none'",
      'frame-src': "'none'",
      'child-src': "'none'",
      'worker-src': "'none'",
      'object-src': "'none'",
      'manifest-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'",
      'frame-ancestors': APP,
      sandbox: 'allow-scripts',
    })
  })

  it('never allows same-origin, eval, inline code without the nonce, or a wildcard', () => {
    const full = frameCsp(INPUT)
    for (const forbidden of ['allow-same-origin', "'unsafe-eval'", "'unsafe-inline'", "'self'", '*', 'data:', 'blob:', "'strict-dynamic'"]) {
      expect(full, forbidden).not.toContain(forbidden)
    }
  })

  it('sends the policy and the other hardening headers, and no app framing header', () => {
    const headers = frameHeaders(INPUT)
    expect(headers).toMatchObject({
      'Content-Security-Policy': frameCsp(INPUT),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'off',
      'Cache-Control': 'no-store',
    })
    expect(headers['Permissions-Policy']).toMatch(/camera=\(\)/)
    expect(headers['Permissions-Policy']).toMatch(/microphone=\(\)/)
    expect(headers).not.toHaveProperty('X-Frame-Options')
  })

  it.each([
    ['an app origin with a path', { ...INPUT, appOrigin: `${APP}/x` }],
    ['a non-http runtime origin', { ...INPUT, runtimeOrigin: 'javascript:alert(1)' }],
    ['a nonce that could break the header', { ...INPUT, nonce: "abc'; script-src *" }],
    ['a runtime that isn’t a version', { ...INPUT, runtime: '../app' as 'v1' }],
  ])('refuses to build with %s', (_label, bad) => {
    expect(() => frameHeaders(bad)).toThrow()
    expect(() => frameHtml(bad)).toThrow()
  })

  it('a v2 bundle gets the v2 runtime files and nothing from v1', () => {
    const v2 = directives(frameCsp({ ...INPUT, runtime: 'v2' }))
    expect(v2['script-src']).toBe(`${RUNTIME}/studio-runtime/v2/runtime.js ${RUNTIME}/studio-runtime/v2/vendor.js 'nonce-${NONCE}'`)
    expect(v2['style-src']).toBe(`${RUNTIME}/studio-runtime/v2/`)
    expect(v2['font-src']).toBe(`${RUNTIME}/studio-runtime/v2/fonts/`)
    const html = frameHtml({ ...INPUT, runtime: 'v2' })
    expect(html).toContain(`<link rel="stylesheet" href="${RUNTIME}/studio-runtime/v2/kit.css">`)
    expect(html).toContain(`<script src="${RUNTIME}/studio-runtime/v2/runtime.js">`)
    expect(html).not.toContain('/studio-runtime/v1/')
  })
})

describe('frame document', () => {
  const html = frameHtml(INPUT)

  it('loads only the runtime, then the vendor file, and keeps the bundle inert until the handshake', () => {
    const scripts = html.match(/<script(?![^>]*type="text\/plain")[^>]*>/g)
    expect(scripts).toEqual([
      `<script src="${RUNTIME}/studio-runtime/v1/runtime.js">`,
      `<script src="${RUNTIME}/studio-runtime/v1/vendor.js">`,
    ])
    expect(html).toContain(`<script type="text/plain" id="${BUNDLE_ELEMENT_ID}" nonce="${NONCE}">`)
    expect(html).toContain(`<link rel="stylesheet" href="${RUNTIME}/studio-runtime/v1/kit.css">`)
  })

  it('carries no IDs and no session data', () => {
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  it('can’t be broken out of by plugin code', () => {
    const evil = frameHtml({ ...INPUT, bundle: 'x="</script><script>alert(1)</script>"; y="<!--"', title: '<img onerror=alert(1)>' })
    const body = evil.slice(evil.indexOf(`id="${BUNDLE_ELEMENT_ID}"`))
    expect(body.indexOf('</script>')).toBe(body.lastIndexOf('</script>'))
    expect(evil).toContain('<title>&lt;img onerror=alert(1)&gt;</title>')
    expect(escapeScriptText('</SCRIPT>')).toBe('<\\/SCRIPT>')
  })
})

describe('origins', () => {
  it('a request is classified by the host the browser asked for, not the server’s own address', () => {
    // What a production Next server hands middleware and routes: nextUrl is built from its
    // listen address, the Host header from the browser's request.
    const origins = studioOrigins({ STUDIO_RUNTIME_ORIGIN: 'https://plugins.example.net', SITE_URL: 'https://app.example.com', NODE_ENV: 'production' })
    const request = (host: string | null) => ({ headers: { get: (n: string) => (n === 'host' ? host : null) }, nextUrl: { host: 'localhost:8080' } })
    expect(requestHost(request('plugins.example.net'))).toBe('plugins.example.net')
    expect(classifyRuntimeRequest(requestHost(request('plugins.example.net')), '/studio-frame/v1/x/student', origins)).toBe('serve-runtime')
    expect(classifyRuntimeRequest(requestHost(request('plugins.example.net')), '/login', origins)).toBe('not-found')
    expect(requestHost(request(null))).toBe('localhost:8080')
  })
  it.each([
    ['unset', {}],
    ['not a URL', { STUDIO_RUNTIME_ORIGIN: 'plugins' }],
    ['with a path', { STUDIO_RUNTIME_ORIGIN: 'http://127.0.0.1:3000/x' }],
    ['the app origin itself', { STUDIO_RUNTIME_ORIGIN: APP }],
    ['the app host on another port', { STUDIO_RUNTIME_ORIGIN: 'http://localhost:4000' }],
    ['a subdomain of the app', { SITE_URL: 'https://app.scholera.example', STUDIO_RUNTIME_ORIGIN: 'https://plugins.app.scholera.example' }],
    ['a parent of the app', { SITE_URL: 'https://app.scholera.example', STUDIO_RUNTIME_ORIGIN: 'https://scholera.example' }],
    ['plain http in production', { NODE_ENV: 'production', SITE_URL: 'https://app.scholera.example', STUDIO_RUNTIME_ORIGIN: 'http://plugins.example' }],
  ])('turns the runtime off when the runtime origin is %s', (_label, env) => {
    expect(studioOrigins(env)).toBeNull()
  })

  it('accepts a different host and prefers SITE_URL for the app, like getSiteUrl', () => {
    expect(studioOrigins({ STUDIO_RUNTIME_ORIGIN: RUNTIME })).toEqual({ app: APP, runtime: RUNTIME })
    expect(
      studioOrigins({ SITE_URL: 'https://app.scholera.example', NEXT_PUBLIC_SITE_URL: APP, STUDIO_RUNTIME_ORIGIN: 'https://plugins.example' }),
    ).toEqual({ app: 'https://app.scholera.example', runtime: 'https://plugins.example' })
  })

  const origins = { app: APP, runtime: RUNTIME }
  it.each([
    ['127.0.0.1:3000', '/studio-frame/v1/x/student', 'serve-runtime'],
    ['127.0.0.1:3000', '/studio-runtime/v1/runtime.js', 'serve-runtime'],
    ['127.0.0.1:3000', '/studio-runtime/v2/kit.css', 'serve-runtime'],
    ['127.0.0.1:3000', '/studio-runtime/v3/runtime.js', 'not-found'],
    ['127.0.0.1:3000', '/login', 'not-found'],
    ['127.0.0.1:3000', '/api/professor-assistant', 'not-found'],
    ['127.0.0.1:3000', '/_next/data/x.json', 'not-found'],
    ['127.0.0.1:3000', '/', 'not-found'],
    ['localhost:3000', '/studio-frame/v1/x/student', 'not-found'],
    ['localhost:3000', '/dashboard', 'continue'],
    ['localhost:3000', '/studio-runtime/v1/runtime.js', 'continue'],
  ])('host %s, path %s: %s', (host, path, expected) => {
    expect(classifyRuntimeRequest(host, path, origins)).toBe(expected)
  })

  it('with the runtime off, the frame path doesn’t exist anywhere', () => {
    expect(classifyRuntimeRequest('localhost:3000', '/studio-frame/v1/x/student', null)).toBe('not-found')
    expect(classifyRuntimeRequest('localhost:3000', '/dashboard', null)).toBe('continue')
  })
})

describe('app headers skip the frame document', () => {
  it('the global anti-framing rule matches every path except /studio-frame/', async () => {
    // Next's own matcher, so this checks the semantics Next applies. It ships untyped.
    const { pathToRegexp } = createRequire(import.meta.url)('next/dist/compiled/path-to-regexp') as {
      pathToRegexp: (path: string, keys: unknown[], options: object) => RegExp
    }
    const config = (await import('../../next.config')).default
    const rules = await config.headers!()
    const framing = rules.find((r) => r.headers.some((h) => h.key === 'X-Frame-Options'))!
    const matches = (p: string) => pathToRegexp(framing.source, [], { strict: true, sensitive: false, delimiter: '/' }).test(p)
    expect(['/', '/dashboard', '/professor/courses/x/studio', '/studio-runtime/v1/runtime.js', '/api/x'].every(matches)).toBe(true)
    expect(matches('/studio-frame/v1/x/student')).toBe(false)
  })
})

describe('bridge envelope', () => {
  const SESSION = crypto.randomUUID()
  const MAX = 64 * 1024

  it.each([
    [{ scholera: 'bridge', v: 1, type: 'hello', runtime: 'v1' }, { type: 'hello', runtime: 'v1' }],
    [
      { scholera: 'bridge', v: 1, type: 'request', session: SESSION, id: 'r1', method: 'records.list', args: { a: 1 } },
      { type: 'request', session: SESSION, id: 'r1', method: 'records.list', args: { a: 1 } },
    ],
    [{ scholera: 'bridge', v: 1, type: 'crash', session: SESSION, message: 'x'.repeat(900) }, { type: 'crash', session: SESSION, message: 'x'.repeat(500) }],
  ])('accepts %j', (raw, parsed) => {
    expect(parseFrameMessage(raw, MAX)).toEqual(parsed)
  })

  it.each([
    ['not an object', 'hello'],
    ['an array', [1]],
    ['another envelope', { scholera: 'other', v: 1, type: 'hello', runtime: 'v1' }],
    ['another version', { scholera: 'bridge', v: 2, type: 'hello', runtime: 'v1' }],
    ['an unknown type', { scholera: 'bridge', v: 1, type: 'welcome', session: SESSION }],
    ['a request without a session', { scholera: 'bridge', v: 1, type: 'request', id: 'r1', method: 'a.b', args: null }],
    ['a malformed session', { scholera: 'bridge', v: 1, type: 'request', session: 'abc', id: 'r1', method: 'a.b', args: null }],
    ['a bad request id', { scholera: 'bridge', v: 1, type: 'request', session: SESSION, id: 'r 1', method: 'a.b', args: null }],
    ['a method with no namespace', { scholera: 'bridge', v: 1, type: 'request', session: SESSION, id: 'r1', method: 'eval', args: null }],
    ['oversized args', { scholera: 'bridge', v: 1, type: 'request', session: SESSION, id: 'r1', method: 'a.b', args: 'x'.repeat(MAX + 1) }],
  ])('rejects %s', (_label, raw) => {
    expect(parseFrameMessage(raw, MAX)).toBeNull()
  })
})

describe('v2 roster and size messages', () => {
  const SESSION = crypto.randomUUID()
  const MAX = 64 * 1024
  const HANDLE = `st_${'a'.repeat(20)}`
  const PAYLOAD = {
    label: 'Attendance',
    sort: 'name',
    searchable: true,
    columns: [{ key: 'status', header: 'Today' }, { key: 'note', header: 'Note' }],
    rows: [
      {
        student: HANDLE,
        cells: {
          status: { kind: 'choice', value: 'present', options: [{ value: 'present', label: 'Present', tone: 'success' }, { value: 'absent', label: 'Absent', tone: 'danger' }] },
          note: { kind: 'text', text: 'Arrived late' },
        },
      },
    ],
    emptyText: 'No students yet.',
  }
  const msg = (extra: Record<string, unknown>) => ({ scholera: 'bridge', v: 1, session: SESSION, ...extra })
  const withRow = (cells: Record<string, unknown>, student = HANDLE) => ({ ...PAYLOAD, rows: [{ student, cells }] })

  it('accepts render, place, remove and size exactly as 3.4 defines them', () => {
    expect(parseFrameMessage(msg({ type: 'roster', op: 'render', slot: 'r1', payload: PAYLOAD }), MAX)).toEqual({ type: 'roster', session: SESSION, op: 'render', slot: 'r1', payload: PAYLOAD })
    const rect = { x: 0, y: 120, width: 640, height: 400 }
    expect(parseFrameMessage(msg({ type: 'roster', op: 'place', slot: 'r1', rect }), MAX)).toEqual({ type: 'roster', session: SESSION, op: 'place', slot: 'r1', rect })
    expect(parseFrameMessage(msg({ type: 'roster', op: 'remove', slot: 'r1' }), MAX)).toEqual({ type: 'roster', session: SESSION, op: 'remove', slot: 'r1' })
    expect(parseFrameMessage(msg({ type: 'size', height: 812 }), MAX)).toEqual({ type: 'size', session: SESSION, height: 812 })
    for (const cell of [
      { kind: 'badge', text: 'Excused', tone: 'warning' },
      { kind: 'select', value: null, placeholder: 'Grade', options: [{ value: 'a', label: 'A' }] },
      { kind: 'button', label: 'Excuse', value: 'excuse', variant: 'secondary' },
    ]) {
      expect(parseRosterPayload(withRow({ status: cell }))).not.toBeNull()
    }
  })

  it.each([
    ['an extra payload field', { ...PAYLOAD, html: '<b>x</b>' }],
    ['an extra cell field', withRow({ note: { kind: 'text', text: 'x', style: 'color:red' } })],
    ['a cell for a column that doesn’t exist', withRow({ other: { kind: 'text', text: 'x' } })],
    ['text over its limit', withRow({ note: { kind: 'text', text: 'x'.repeat(61) } })],
    ['a user ID instead of a handle', withRow({}, crypto.randomUUID())],
    ['the same student twice', { ...PAYLOAD, rows: [PAYLOAD.rows[0], PAYLOAD.rows[0]] }],
    ['five columns', { ...PAYLOAD, columns: ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, header: key })) }],
    ['a choice with one option', withRow({ status: { kind: 'choice', value: null, options: [{ value: 'p', label: 'P', tone: 'success' }] } })],
    ['an unknown tone', withRow({ status: { kind: 'badge', text: 'x', tone: 'red' } })],
    ['an unknown cell kind', withRow({ status: { kind: 'html', text: 'x' } })],
    ['an unknown sort', { ...PAYLOAD, sort: 'id' }],
  ])('refuses a payload with %s', (_label, payload) => {
    expect(parseRosterPayload(payload)).toBeNull()
    expect(parseFrameMessage(msg({ type: 'roster', op: 'render', slot: 'r1', payload }), MAX)).toBeNull()
  })

  it.each([
    ['a slot that isn’t a short token', msg({ type: 'roster', op: 'remove', slot: 'R-1' })],
    ['an unknown op', msg({ type: 'roster', op: 'names', slot: 'r1' })],
    ['a rect with a missing side', msg({ type: 'roster', op: 'place', slot: 'r1', rect: { x: 0, y: 0, width: 10 } })],
    ['a negative height', msg({ type: 'size', height: -1 })],
    ['a height that isn’t a number', msg({ type: 'size', height: '900px' })],
  ])('refuses %s', (_label, raw) => {
    expect(parseFrameMessage(raw, MAX)).toBeNull()
  })
})

describe('frame tickets', () => {
  const ticket = {
    installationId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    view: 'student' as const,
    expiresAt: Date.now() + 60_000,
  }

  it('round-trips', () => {
    expect(verifyFrameTicket(signFrameTicket(ticket, SECRET), SECRET)).toEqual(ticket)
  })

  it('carries no user', () => {
    const body = JSON.parse(Buffer.from(signFrameTicket(ticket, SECRET).split('.')[0], 'base64url').toString())
    expect(Object.keys(body).sort()).toEqual(['e', 'i', 'r', 'w'])
  })

  it.each([
    ['a changed view', () => signFrameTicket(ticket, SECRET).replace(/^[^.]+/, Buffer.from(JSON.stringify({ i: ticket.installationId, r: ticket.versionId, w: 'professor', e: ticket.expiresAt })).toString('base64url'))],
    ['another secret', () => signFrameTicket(ticket, 'another-secret-that-is-also-long-enough-to-pass')],
    ['an expired ticket', () => signFrameTicket({ ...ticket, expiresAt: Date.now() - 1 }, SECRET)],
    ['no signature', () => signFrameTicket(ticket, SECRET).split('.')[0]],
    ['junk', () => 'abc.def.ghi'],
  ])('refuses %s', (_label, make) => {
    expect(verifyFrameTicket(make(), SECRET)).toBeNull()
  })

  describe('issueFrameUrl', () => {
    beforeEach(() => {
      vi.stubEnv('STUDIO_RUNTIME_ORIGIN', RUNTIME)
      vi.stubEnv('SITE_URL', APP)
      vi.stubEnv('STUDIO_FRAME_TICKET_SECRET', SECRET)
    })
    afterEach(() => vi.unstubAllEnvs())

    const viewer = (role: StudioViewer['role']) =>
      ({ role, installationId: ticket.installationId, versionId: ticket.versionId }) as StudioViewer

    it('gives a student a student-view URL on the runtime origin, for the current version', async () => {
      vi.mocked(resolveViewer).mockResolvedValue(viewer('student'))
      const url = new URL((await issueFrameUrl(ticket.installationId, 'student'))!)
      expect(url.origin).toBe(RUNTIME)
      expect(url.pathname).toBe(`/studio-frame/v1/${ticket.installationId}/student`)
      expect(verifyFrameTicket(url.searchParams.get('t'), SECRET)).toMatchObject({ versionId: ticket.versionId, view: 'student' })
    })

    it('never gives a student the professor view', async () => {
      vi.mocked(resolveViewer).mockResolvedValue(viewer('student'))
      expect(await issueFrameUrl(ticket.installationId, 'professor')).toBeNull()
    })

    it.each(['professor', 'ta', 'grader'] as const)('gives a %s either view', async (role) => {
      vi.mocked(resolveViewer).mockResolvedValue(viewer(role))
      expect(await issueFrameUrl(ticket.installationId, 'professor')).not.toBeNull()
      expect(await issueFrameUrl(ticket.installationId, 'student')).not.toBeNull()
    })

    it('refuses without a viewer, and when the runtime isn’t configured', async () => {
      vi.mocked(resolveViewer).mockResolvedValue(null)
      expect(await issueFrameUrl(ticket.installationId, 'student')).toBeNull()
      vi.mocked(resolveViewer).mockResolvedValue(viewer('professor'))
      vi.stubEnv('STUDIO_FRAME_TICKET_SECRET', 'short')
      expect(await issueFrameUrl(ticket.installationId, 'student')).toBeNull()
    })

    it('signs a candidate version only when Step 3 confirms it for this professor', async () => {
      const candidate = crypto.randomUUID()
      vi.mocked(resolveViewer).mockResolvedValue(viewer('professor'))
      vi.mocked(candidateVersion).mockResolvedValue(null)
      expect(await issueFrameUrl(ticket.installationId, 'student', candidate)).toBeNull()
      vi.mocked(candidateVersion).mockResolvedValue({ versionId: candidate, manifest: {} } as never)
      const url = new URL((await issueFrameUrl(ticket.installationId, 'student', candidate))!)
      expect(verifyFrameTicket(url.searchParams.get('t'), SECRET)).toMatchObject({ versionId: candidate, view: 'student' })
    })
  })
})

describe('frame route', () => {
  beforeEach(() => {
    vi.stubEnv('STUDIO_RUNTIME_ORIGIN', RUNTIME)
    vi.stubEnv('SITE_URL', APP)
    vi.stubEnv('STUDIO_FRAME_TICKET_SECRET', SECRET)
    vi.mocked(loadVersionBundle).mockResolvedValue({ code: 'window.probe = 1', name: 'Exit ticket', bridgeVersion: 'v1' })
    vi.mocked(studioKillSwitchEngaged).mockResolvedValue(false)
  })
  afterEach(() => vi.unstubAllEnvs())

  const installationId = crypto.randomUUID()

  it('404s while the Studio kill switch is engaged, even with a valid ticket, without loading code', async () => {
    vi.mocked(loadVersionBundle).mockClear()
    vi.mocked(studioKillSwitchEngaged).mockResolvedValue(true)
    const res = await frameResponse('127.0.0.1:3000', installationId, 'student', token())
    expect(res.status).toBe(404)
    expect(loadVersionBundle).not.toHaveBeenCalled()
  })

  it('serves the bundle named by the ticket, for the view named by the ticket', async () => {
    vi.mocked(loadVersionBundle).mockClear()
    const versionId = crypto.randomUUID()
    const ticket = signFrameTicket({ installationId, versionId, view: 'student', expiresAt: Date.now() + 60_000 }, SECRET)
    await frameResponse('127.0.0.1:3000', installationId, 'student', ticket)
    expect(loadVersionBundle).toHaveBeenCalledWith(versionId, 'student')
  })
  const token = (view: 'student' | 'professor' = 'student') =>
    signFrameTicket({ installationId, versionId: crypto.randomUUID(), view, expiresAt: Date.now() + 60_000 }, SECRET)

  it('serves the document with its security headers, and the nonce in the policy is the bundle’s', async () => {
    const res = await frameResponse('127.0.0.1:3000', installationId, 'student', token())
    expect(res.status).toBe(200)
    const csp = res.headers.get('Content-Security-Policy')!
    const html = await res.text()
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]
    expect(html).toContain(`nonce="${nonce}"`)
    expect(html).toContain('window.probe = 1')
    expect(csp).toContain(`frame-ancestors ${APP}`)
  })

  it('uses a fresh nonce for every response', async () => {
    const a = (await frameResponse('127.0.0.1:3000', installationId, 'student', token())).headers.get('Content-Security-Policy')
    const b = (await frameResponse('127.0.0.1:3000', installationId, 'student', token())).headers.get('Content-Security-Policy')
    expect(a).not.toBe(b)
  })

  it.each([
    ['the app origin', 'localhost:3000', 'student', () => token()],
    ['no ticket', '127.0.0.1:3000', 'student', () => null],
    ['a student ticket asked for the professor view', '127.0.0.1:3000', 'professor', () => token('student')],
    ['a tampered ticket', '127.0.0.1:3000', 'student', () => `${token()}x`],
  ])('404s, the same way every time, on %s', async (_label, host, view, makeToken) => {
    const res = await frameResponse(host, installationId, view, makeToken())
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not found')
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })

  it('loads the runtime of the version’s own bridge, and 404s for a bridge the platform doesn’t serve', async () => {
    vi.mocked(loadVersionBundle).mockResolvedValue({ code: 'window.probe = 1', name: 'Exit ticket', bridgeVersion: 'v2' })
    const v2 = await frameResponse('127.0.0.1:3000', installationId, 'student', token())
    expect(v2.headers.get('Content-Security-Policy')).toContain(`script-src ${RUNTIME}/studio-runtime/v2/runtime.js`)
    vi.mocked(loadVersionBundle).mockResolvedValue({ code: 'window.probe = 1', name: 'Exit ticket', bridgeVersion: 'v0' })
    expect((await frameResponse('127.0.0.1:3000', installationId, 'student', token())).status).toBe(404)
  })

  it('404s for another installation’s ticket', async () => {
    const res = await frameResponse('127.0.0.1:3000', crypto.randomUUID(), 'student', token())
    expect(res.status).toBe(404)
  })
})
