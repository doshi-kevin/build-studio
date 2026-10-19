/**
 * The code a LocalProcessExecutor child runs (`node --permission -e SANDBOX_SOURCE`), held
 * as a string so the standalone build needs no file of its own for it. Plain CommonJS,
 * never transpiled: what is written here is exactly what runs.
 *
 * Inside the child there are two realms:
 *
 *   the runner   this file's top level: reads the start message and capability replies on
 *                stdin, writes capability calls and the result on stdout. Has `process`.
 *   the plugin   a fresh vm context, with string code generation and WebAssembly off. It
 *                holds only ECMAScript built-ins, the prelude below and the plugin bundle.
 *
 * Nothing of the runner's realm is handed to the plugin's: the prelude keeps the one
 * runner function it needs (`send`, strictly a string in, nothing out, never throws) in a
 * closure and calls it directly, and every reply crosses as a JSON string parsed inside the
 * plugin's realm. So the plugin can't reach `process`, `require` or a host object to climb
 * out through. That is defence in depth: the process boundary is what the executor relies
 * on (no environment, Node's permission model, a heap cap, a wall-clock kill).
 */
import {
  STUDIO_SERVER_ACTION_LOG_EVENTS_MAX,
  STUDIO_SERVER_ACTION_MAX_CAPABILITY_CALLS,
  STUDIO_SERVER_ACTION_TIMEOUT_MS,
} from '../limits'

/** The longest line either side accepts: a result, or a page of records in a reply. */
export const SANDBOX_MAX_LINE_CHARS = 4 * 1024 * 1024

export const SANDBOX_SOURCE = String.raw`'use strict'
const vm = require('node:vm')
const LIMITS = { calls: ${STUDIO_SERVER_ACTION_MAX_CAPABILITY_CALLS}, logs: ${STUDIO_SERVER_ACTION_LOG_EVENTS_MAX}, line: ${SANDBOX_MAX_LINE_CHARS}, evalMs: 2000, lifeMs: ${STUDIO_SERVER_ACTION_TIMEOUT_MS + 2000} }

// The plugin realm's runtime. Runs inside the vm context; its source is this function's text.
function prelude(send, MAX_CALLS, MAX_LOGS) {
  'use strict'
  var parse = JSON.parse
  var stringify = JSON.stringify
  var freeze = Object.freeze
  var hasOwn = Object.prototype.hasOwnProperty
  var pending = new Map()
  var nextId = 1
  var calls = 0
  var logs = 0
  function post(message) {
    var text
    try { text = stringify(message) } catch (e) { return false }
    if (typeof text !== 'string') return false
    try { send(text) } catch (e) { return false }
    return true
  }
  function call(method, params) {
    calls += 1
    if (calls > MAX_CALLS) return Promise.reject(new Error('This action made too many requests.'))
    var id = nextId++
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject })
      if (!post({ type: 'call', id: id, method: method, params: params })) {
        pending.delete(id)
        reject(new Error('This request could not be sent.'))
      }
    })
  }
  function deliver(line) {
    var message
    try { message = parse(line) } catch (e) { return }
    var entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok === true) entry.resolve(message.data)
    else entry.reject(new Error(typeof message.message === 'string' ? message.message : 'This request was refused.'))
  }
  // xmur3 to seed mulberry32: small, fast, and the same sequence for the same seed everywhere.
  function random(seed) {
    var s = String(seed)
    var h = 1779033703 ^ s.length
    for (var i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
      h = (h << 13) | (h >>> 19)
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    var a = (h ^ (h >>> 16)) >>> 0
    return function () {
      a = (a + 0x6d2b79f5) | 0
      var t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  function opt(o, k) { return o !== null && typeof o === 'object' ? o[k] : undefined }
  var records = freeze({
    list: function (collection, options) { return call('records.list', { collection: collection, limit: opt(options, 'limit'), offset: opt(options, 'offset') }) },
    listAll: function (collection) {
      var all = []
      function page(n) {
        return call('records.list', { collection: collection, limit: 100, offset: n * 100 }).then(function (rows) {
          for (var i = 0; i < rows.length; i++) all.push(rows[i])
          return rows.length === 100 && n < 9 ? page(n + 1) : all
        })
      }
      return page(0)
    },
    get: function (collection, recordId) { return call('records.get', { collection: collection, recordId: recordId }) },
    create: function (collection, data, options) { return call('records.create', { collection: collection, data: data, student: opt(options, 'student') }) },
    update: function (collection, recordId, data, options) { return call('records.update', { collection: collection, recordId: recordId, data: data, expectedUpdatedAt: opt(options, 'expectedUpdatedAt') }) },
    remove: function (collection, recordId) { return call('records.delete', { collection: collection, recordId: recordId }).then(function () { return undefined }) },
  })
  function run(exports, argsJson, contextJson) {
    var context = parse(contextJson)
    var args = parse(argsJson)
    var ctx = freeze({
      user: freeze({ role: context.role, handle: context.handle }),
      records: records,
      course: freeze({ get: function () { return call('course.get', {}) } }),
      log: freeze({ event: function (name, data) { logs += 1; if (logs <= MAX_LOGS) post({ type: 'log', name: name, data: data }) } }),
      random: random,
      now: function () { return context.now },
    })
    var fn
    try {
      var actions = exports !== null && typeof exports === 'object' ? exports.actions : undefined
      fn = actions !== null && typeof actions === 'object' && hasOwn.call(actions, context.action) ? actions[context.action] : undefined
    } catch (e) {
      fn = undefined
    }
    if (typeof fn !== 'function') {
      post({ type: 'done', ok: false, reason: 'missing_action' })
      return
    }
    new Promise(function (resolve) { resolve(fn(ctx, args)) }).then(
      function (result) {
        var text
        try { text = stringify(result === undefined ? null : result) } catch (e) { text = undefined }
        if (typeof text === 'string') post({ type: 'done', ok: true, result: text })
        else post({ type: 'done', ok: false, reason: 'unserializable' })
      },
      function (error) {
        var message = ''
        try { message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message.slice(0, 300) : '' } catch (e) {}
        post({ type: 'done', ok: false, reason: 'threw', message: message })
      },
    )
  }
  return { deliver: deliver, run: run }
}

function out(text) {
  process.stdout.write(text + '\n')
}

// The one runner function the plugin realm can call, through the prelude's closure.
function send(text) {
  if (typeof text !== 'string' || text.length > LIMITS.line || text.indexOf('\n') !== -1) return
  out(text)
}

let deliver = null
let started = false

function start(message) {
  const holder = vm.constants && vm.constants.DONT_CONTEXTIFY ? vm.constants.DONT_CONTEXTIFY : Object.create(null)
  const context = vm.createContext(holder, { name: 'plugin', codeGeneration: { strings: false, wasm: false } })
  // Binary buffers live outside the V8 heap, where --max-old-space-size can't bound them.
  vm.runInContext(
    "for (const n of ['ArrayBuffer', 'SharedArrayBuffer', 'Atomics', 'DataView', 'WebAssembly', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']) delete globalThis[n]",
    context,
  )
  const install = vm.runInContext('(' + prelude.toString() + ')', context, { timeout: LIMITS.evalMs })
  const runtime = install(send, LIMITS.calls, LIMITS.logs)
  deliver = runtime.deliver
  const run = runtime.run
  let exported
  try {
    exported = vm.runInContext(message.bundle, context, { timeout: LIMITS.evalMs, filename: 'plugin-server.js' })
  } catch (e) {
    out(JSON.stringify({ type: 'done', ok: false, reason: 'threw', message: '' }))
    return
  }
  try {
    run(exported, message.args, message.context)
  } catch (e) {
    out(JSON.stringify({ type: 'done', ok: false, reason: 'threw', message: '' }))
  }
}

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (chunk) {
  buffered += chunk
  if (buffered.length > LIMITS.line) process.exit(3)
  let i
  while ((i = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, i)
    buffered = buffered.slice(i + 1)
    let message
    try { message = JSON.parse(line) } catch (e) { process.exit(3) }
    if (message.type === 'start' && !started) {
      started = true
      start(message)
    } else if (message.type === 'reply' && deliver) {
      try { deliver(line) } catch (e) {}
    }
  }
})
process.stdin.on('end', function () { process.exit(0) })
setTimeout(function () { process.exit(4) }, LIMITS.lifeMs).unref()
`
