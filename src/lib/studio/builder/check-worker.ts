/**
 * Runs the builder's compile and typecheck in a worker thread, with a heap cap and a
 * wall-clock limit (STUDIO_BUILDER_CHECK_TIMEOUT_MS, STUDIO_BUILDER_CHECK_WORKER_MAX_MB).
 * A check that runs over, exhausts its heap or crashes is terminated, and the next call
 * starts a fresh worker. Calls run one at a time; the limit starts when a call is sent
 * to the worker, not while it waits its turn.
 *
 * The worker's code is the generated string in check-worker.generated.ts (see
 * scripts/studio/build-check-worker.mjs). It requires only `typescript`, resolved from
 * the server's working directory, where Next's standalone output keeps it.
 */
import 'server-only'
import { Worker } from 'node:worker_threads'
import { STUDIO_BUILDER_CHECK_TIMEOUT_MS, STUDIO_BUILDER_CHECK_WORKER_MAX_MB } from '../limits'
import { CHECK_WORKER_SOURCE } from './check-worker.generated'
import { CheckFault, CheckTimeout } from './check-worker-errors'
import type { CompileResult } from './compile'
import type { PluginPath } from './paths'
import type { TypecheckResult } from './typecheck'

export interface WorkerCheck {
  compiler: string
  compile: Record<PluginPath, CompileResult>
  typecheck: TypecheckResult
}

export { CheckFault, CheckTimeout }

let worker: Worker | null = null
let nextId = 1
let queue: Promise<unknown> = Promise.resolve()

function start(): Worker {
  const w = new Worker(CHECK_WORKER_SOURCE, {
    eval: true,
    // Nothing of the server's: no secrets in env, no arguments, no Node flags.
    env: {},
    argv: [],
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: STUDIO_BUILDER_CHECK_WORKER_MAX_MB },
  })
  // An idle worker never keeps the process alive.
  w.unref()
  return w
}

function stop(w: Worker) {
  if (worker === w) worker = null
  void w.terminate()
}

function dispatch(files: Record<PluginPath, string>, timeoutMs: number): Promise<WorkerCheck> {
  const w = (worker ??= start())
  const id = nextId++
  return new Promise<WorkerCheck>((resolve, reject) => {
    const finish = (fn: () => void) => {
      clearTimeout(timer)
      w.off('message', onMessage)
      w.off('error', onError)
      w.off('exit', onExit)
      fn()
    }
    const onMessage = (msg: { id: number; result?: WorkerCheck; fault?: string }) => {
      if (msg.id !== id) return
      finish(() => (msg.result ? resolve(msg.result) : reject(new CheckFault(msg.fault ?? 'check failed'))))
    }
    const onError = (error: Error) => finish(() => {
      stop(w)
      // ERR_WORKER_OUT_OF_MEMORY when the heap cap is hit.
      reject(new CheckTimeout((error as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crashed'))
    })
    const onExit = () => finish(() => {
      if (worker === w) worker = null
      reject(new CheckTimeout('exited'))
    })
    const timer = setTimeout(() => finish(() => {
      stop(w)
      reject(new CheckTimeout('time'))
    }), timeoutMs)
    w.on('message', onMessage)
    w.once('error', onError)
    w.once('exit', onExit)
    w.postMessage({ id, files })
  })
}

/** Compile and typecheck both views. Throws CheckTimeout or CheckFault. */
export function runWorkerCheck(files: Record<PluginPath, string>, timeoutMs = STUDIO_BUILDER_CHECK_TIMEOUT_MS): Promise<WorkerCheck> {
  const call = queue.then(() => dispatch(files, timeoutMs))
  // The queue continues whatever this call's outcome.
  queue = call.catch(() => undefined)
  return call
}
