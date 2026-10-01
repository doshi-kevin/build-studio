/*
 * Scholera Studio plugin runtime, bridge v1.
 *
 * Runs inside the sandboxed plugin frame, on the dedicated runtime origin, before any
 * plugin code. This file is part of the bridge contract (rule 8.7): once released, v1
 * stays as it is and a new runtime gets a new path. Contract:
 * docs/reference/studio-plugin-runtime.md.
 *
 * It shares a realm with the plugin, so nothing here is a security boundary. The
 * boundaries are the sandbox, the security policy and the host. This file only:
 *   - removes channels the policy can't cover, before plugin code exists (N10, N11);
 *   - runs the handshake, then starts the inert plugin bundle;
 *   - gives the plugin a small request API.
 */
(function () {
  'use strict'

  var RUNTIME = 'v1'
  var BUNDLE_ID = 'studio-plugin-bundle'
  var host = window.parent

  // N10. Browsers don't reliably apply the security policy to WebRTC, so the
  // constructors are removed. A determined script may still find one; the isolation
  // probes record what each browser allows.
  ;[
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel',
    'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver',
    'RTCRtpTransceiver', 'RTCDtlsTransport', 'RTCIceTransport', 'RTCSctpTransport', 'RTCCertificate',
  ].forEach(function (name) {
    try {
      Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false })
    } catch {
      /* not defined in this browser */
    }
  })

  // N11. Resource hints can open connections the policy may not govern, and a meta
  // refresh is a navigation. Remove them the moment they appear.
  var HINT = /^(dns-prefetch|preconnect|prefetch|prerender|preload|modulepreload)$/i
  function isHint(el) {
    if (el.tagName === 'LINK') {
      return (el.getAttribute('rel') || '').split(/\s+/).some(function (t) { return HINT.test(t) })
    }
    return el.tagName === 'META' && /refresh/i.test(el.getAttribute('http-equiv') || '')
  }
  function scrub(node) {
    if (!node || node.nodeType !== 1) return
    if (isHint(node)) return node.remove()
    if (node.querySelectorAll) node.querySelectorAll('link, meta').forEach(function (el) { if (isHint(el)) el.remove() })
  }
  new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.type === 'attributes') scrub(r.target)
      r.addedNodes.forEach(scrub)
    })
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['rel', 'http-equiv'] })

  // ── Bridge ──────────────────────────────────────────────────────────
  var session = null
  var nextId = 0
  var pending = {}
  var started = false

  function post(message) {
    message.scholera = 'bridge'
    message.v = 1
    // The parent is always Scholera: the document's frame-ancestors allows nothing else.
    host.postMessage(message, '*')
  }

  function request(method, args) {
    if (session === null) return Promise.reject(Object.freeze({ code: 'not_available', message: 'Not connected.' }))
    nextId += 1
    var id = 'r' + nextId
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject }
      try {
        post({ type: 'request', session: session, id: id, method: method, args: args === undefined ? null : args })
      } catch {
        delete pending[id]
        reject(Object.freeze({ code: 'invalid', message: 'That request can’t be sent.' }))
      }
    })
  }

  function crash(message) {
    if (session !== null) post({ type: 'crash', session: session, message: String(message).slice(0, 500) })
  }

  function start(context) {
    if (started) return
    started = true
    Object.defineProperty(window, 'ScholeraStudio', {
      value: Object.freeze({ context: Object.freeze(context || {}), request: request }),
      writable: false,
      configurable: false,
    })
    var data = document.getElementById(BUNDLE_ID)
    if (!data) return crash('The plugin bundle is missing.')
    // The bundle was inert text until now. It runs only after the host has seen the
    // frame's first load event, so any navigation it causes is load #2.
    var script = document.createElement('script')
    script.nonce = data.nonce
    script.textContent = data.textContent
    data.remove()
    document.body.appendChild(script)
  }

  window.addEventListener('message', function (event) {
    if (event.source !== host) return
    var d = event.data
    if (!d || d.scholera !== 'bridge' || d.v !== 1) return
    if (d.type === 'welcome' && session === null && typeof d.session === 'string') {
      session = d.session
      start(d.context)
      return
    }
    if (d.type === 'response' && d.session === session && Object.prototype.hasOwnProperty.call(pending, d.id)) {
      var p = pending[d.id]
      delete pending[d.id]
      if (d.ok) p.resolve(d.data)
      else p.reject(Object.freeze({ code: d.error && d.error.code, message: d.error && d.error.message }))
    }
  })

  window.addEventListener('error', function (e) { crash(e.message || 'Script error') })
  window.addEventListener('unhandledrejection', function () { crash('Unhandled rejection') })

  post({ type: 'hello', runtime: RUNTIME })
})()
