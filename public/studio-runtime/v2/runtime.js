/*
 * Scholera Studio plugin runtime, bridge v2.
 *
 * Runs inside the sandboxed plugin frame, on the dedicated runtime origin, before any
 * plugin code. This file is part of the bridge contract (rule 8.7): once released, v2
 * stays as it is and a new runtime gets a new path. Contract:
 * docs/reference/studio-plugin-runtime.md; what v2 adds over v1:
 * docs/designs/studio/studio-builder-quality.md 3.4.
 *
 * It shares a realm with the plugin, so nothing here is a security boundary. The
 * boundaries are the sandbox, the security policy and the host. This file only:
 *   - removes channels the policy can't cover, before plugin code exists (N10, N11);
 *   - runs the handshake, then starts the inert plugin bundle;
 *   - gives the plugin a small request API;
 *   - (v2) passes RosterTable placeholders to the host, which draws the names over them,
 *     and hands the plugin the professor's roster actions;
 *   - (v2) reports the document's height, so the host fits the frame to its content.
 */
(function () {
  'use strict'

  var RUNTIME = 'v2'
  var BUNDLE_ID = 'studio-plugin-bundle'
  var host = window.parent
  // Taken before plugin code exists, so a plugin replacing them changes nothing here.
  var Observer = window.ResizeObserver
  var setTimer = window.setTimeout.bind(window)

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
  var listeners = { 'roster.action': [] }

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

  // ── Roster (v2): the plugin describes the table, the host draws it with names ──
  // Only shape is sent here; the host's strict parse is the check, and a malformed
  // message is a strike against the frame.
  function rosterSend(message) {
    if (session === null) return
    message.type = 'roster'
    message.session = session
    try {
      post(message)
    } catch {
      /* not cloneable: nothing reaches the host */
    }
  }
  var roster = Object.freeze({
    render: function (slot, payload) { rosterSend({ op: 'render', slot: slot, payload: payload }) },
    place: function (slot, rect) { rosterSend({ op: 'place', slot: slot, rect: rect }) },
    remove: function (slot) { rosterSend({ op: 'remove', slot: slot }) },
  })

  function on(name, handler) {
    if (!Object.prototype.hasOwnProperty.call(listeners, name) || typeof handler !== 'function') {
      throw new TypeError('Unknown event: ' + String(name))
    }
    listeners[name].push(handler)
    return function off() {
      var i = listeners[name].indexOf(handler)
      if (i >= 0) listeners[name].splice(i, 1)
    }
  }

  // ── Auto height (v2): at most one report every 100 ms, only when it changed ──
  var SIZE_MS = 100
  var sizeTimer = null
  var lastHeight = -1
  var lastSizeAt = 0
  function contentHeight() {
    // The content's own extent, not the viewport's: html may be as tall as the frame,
    // which would keep a frame from ever shrinking.
    var root = document.getElementById('root')
    var body = document.body
    if (!root || !body) return document.documentElement.scrollHeight
    var style = window.getComputedStyle(body)
    var bottom = root.getBoundingClientRect().bottom + window.scrollY
    return Math.ceil(bottom + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.marginBottom) || 0))
  }
  function reportSize() {
    sizeTimer = null
    if (session === null) return
    var height = contentHeight()
    if (height === lastHeight) return
    lastHeight = height
    lastSizeAt = Date.now()
    post({ type: 'size', session: session, height: height })
  }
  function scheduleSize() {
    if (sizeTimer !== null) return
    sizeTimer = setTimer(reportSize, Math.max(0, SIZE_MS - (Date.now() - lastSizeAt)))
  }
  function watchSize() {
    var root = document.getElementById('root')
    if (Observer && root) new Observer(scheduleSize).observe(root)
    window.addEventListener('resize', scheduleSize)
    scheduleSize()
  }

  function crash(message) {
    if (session !== null) post({ type: 'crash', session: session, message: String(message).slice(0, 500) })
  }

  function start(context) {
    if (started) return
    started = true
    Object.defineProperty(window, 'ScholeraStudio', {
      value: Object.freeze({ context: Object.freeze(context || {}), request: request, roster: roster, on: on }),
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
    watchSize()
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
      return
    }
    if (d.type === 'event' && d.session === session && session !== null && d.name === 'roster.action' && d.data) {
      var data = Object.freeze({ slot: String(d.data.slot), student: String(d.data.student), column: String(d.data.column), value: String(d.data.value) })
      // A copy, so a handler that unsubscribes itself doesn't skip the next one.
      listeners['roster.action'].slice().forEach(function (handler) { handler(data) })
    }
  })

  window.addEventListener('error', function (e) { crash(e.message || 'Script error') })
  window.addEventListener('unhandledrejection', function () { crash('Unhandled rejection') })

  post({ type: 'hello', runtime: RUNTIME })
})()
