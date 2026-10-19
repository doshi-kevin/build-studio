/**
 * LocalProcessExecutor: runs one server action in a fresh `node` child process.
 *
 *   - One process per call, so nothing survives between calls, users or installations.
 *   - An environment of NODE_ENV alone: no secret, key or database URL exists in the child.
 *   - Node's permission model (`--permission`): no file system reads or writes, no child
 *     processes, no worker threads, no native addons.
 *   - A heap cap, with no binary buffers in the plugin's realm (their memory would sit outside
 *     it), a wall-clock kill at STUDIO_SERVER_ACTION_TIMEOUT_MS, and at most
 *     STUDIO_SERVER_ACTION_MAX_CONCURRENT children at once per server process.
 *   - Plugin code in a vm context of its own (sandbox-source.ts), with no host object in it
 *     and string code generation off.
 *
 * What it does NOT give: Node 24's permission model doesn't restrict the network, so code
 * that escaped the vm context could open a socket. There is no seccomp, namespace or
 * egress rule here. That is why this executor runs only on a developer machine
 * (executor.ts); production needs the container executor, with egress denied.
 *
 * The child's output is untrusted: every line is size-capped and parsed as data.
 */
import 'server-only'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import {
  STUDIO_SERVER_ACTION_HEAP_MB,
  STUDIO_SERVER_ACTION_LOG_EVENTS_MAX,
  STUDIO_SERVER_ACTION_MAX_CAPABILITY_CALLS,
  STUDIO_SERVER_ACTION_MAX_CONCURRENT,
  STUDIO_SERVER_ACTION_RESULT_MAX_BYTES,
  STUDIO_SERVER_ACTION_TIMEOUT_MS,
} from '../limits'
import {
  isCapabilityMethod,
  parseLogEvent,
  type CapabilityHandler,
  type ExecutionOutcome,
  type ExecutionRequest,
  type LogEvent,
  type PluginExecutor,
} from './contract'
import { SANDBOX_MAX_LINE_CHARS, SANDBOX_SOURCE } from './sandbox-source'

const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission'

// Children running now, in this server process.
let running = 0

export class LocalProcessExecutor implements PluginExecutor {
  readonly kind = 'local' as const

  constructor(private readonly timeoutMs = STUDIO_SERVER_ACTION_TIMEOUT_MS) {}

  execute(request: ExecutionRequest, capability: CapabilityHandler): Promise<ExecutionOutcome> {
    if (running >= STUDIO_SERVER_ACTION_MAX_CONCURRENT) return Promise.resolve({ ok: false, reason: 'busy', logs: [] })
    running += 1
    return new Promise<ExecutionOutcome>((resolve) => {
      const logs: LogEvent[] = []
      let finished = false
      let calls = 0
      let buffered = ''

      const child = spawn(
        process.execPath,
        [PERMISSION_FLAG, `--max-old-space-size=${STUDIO_SERVER_ACTION_HEAP_MB}`, '--disallow-code-generation-from-strings', '-e', SANDBOX_SOURCE],
        { env: { NODE_ENV: 'production' }, cwd: tmpdir(), stdio: 'pipe', windowsHide: true },
      )
      const finish = (outcome: ExecutionOutcome) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        running -= 1
        resolve(outcome)
      }
      const fail = (reason: Extract<ExecutionOutcome, { ok: false }>['reason'], message?: string) => finish({ ok: false, reason, message, logs })
      const timer = setTimeout(() => fail('timeout'), this.timeoutMs)
      const write = (message: unknown) => {
        if (!finished && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
      }

      const handle = (line: string) => {
        let message: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(line)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('protocol')
          message = parsed as Record<string, unknown>
        } catch {
          return fail('protocol')
        }
        if (message.type === 'call') {
          const id = message.id
          if (!Number.isInteger(id) || !isCapabilityMethod(message.method)) return fail('protocol')
          calls += 1
          if (calls > STUDIO_SERVER_ACTION_MAX_CAPABILITY_CALLS) return fail('too_many_calls')
          // A call already under way when the action ends still finishes (records are written
          // one by one, never as a transaction); nothing new starts after it.
          if (finished) return
          void capability(message.method, message.params ?? {}).then(
            (r) => write(r.ok ? { type: 'reply', id, ok: true, data: r.data ?? null } : { type: 'reply', id, ok: false, message: r.message }),
            () => write({ type: 'reply', id, ok: false, message: 'Something went wrong. Try again.' }),
          )
          return
        }
        if (message.type === 'log') {
          const event = parseLogEvent({ name: message.name, data: message.data ?? undefined })
          if (event && logs.length < STUDIO_SERVER_ACTION_LOG_EVENTS_MAX) logs.push(event)
          return
        }
        if (message.type === 'done') {
          if (message.ok === true) {
            if (typeof message.result !== 'string') return fail('protocol')
            if (Buffer.byteLength(message.result) > STUDIO_SERVER_ACTION_RESULT_MAX_BYTES) return fail('too_large')
            return finish({ ok: true, resultJson: message.result, logs })
          }
          const reason = message.reason
          if (reason === 'missing_action' || reason === 'unserializable') return fail(reason)
          return fail('threw', typeof message.message === 'string' ? message.message.slice(0, 300) : undefined)
        }
        fail('protocol')
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk
        if (buffered.length > SANDBOX_MAX_LINE_CHARS) return fail('too_large')
        let i: number
        while (!finished && (i = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, i)
          buffered = buffered.slice(i + 1)
          handle(line)
        }
      })
      // Whatever the child prints on stderr is dropped: it could only be plugin-influenced text.
      child.stderr.resume()
      child.stdin.on('error', () => fail('crashed'))
      child.on('error', () => fail('crashed'))
      // 'close', not 'exit': a crash's last line on stdout is read before it counts as one.
      child.on('close', () => fail('crashed'))

      write({
        type: 'start',
        bundle: request.bundle,
        args: request.argsJson,
        context: JSON.stringify({ action: request.action, role: request.caller.role, handle: request.caller.handle, now: request.now }),
      })
    })
  }
}
