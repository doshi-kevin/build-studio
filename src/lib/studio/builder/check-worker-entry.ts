/**
 * The check worker's own code: compile and typecheck the package off the request thread.
 * `ts.createProgram` is synchronous, so untrusted types could otherwise stall a shared
 * Cloud Run instance; here the parent can stop it with `terminate()`.
 *
 * Not imported by the app. scripts/studio/build-check-worker.mjs bundles this file into
 * check-worker.generated.ts, which the parent starts as an eval'd worker. Nothing here
 * may import server code: a worker thread runs outside the Next server.
 */
import { parentPort } from 'node:worker_threads'
import { COMPILER_ID, CompilerFault, compilePackage } from './compile'
import { typecheckPackage } from './typecheck'

export interface CheckRequest {
  id: number
  files: Record<string, string>
}

parentPort?.on('message', (msg: CheckRequest) => {
  try {
    parentPort!.postMessage({ id: msg.id, result: { compiler: COMPILER_ID, compile: compilePackage(msg.files), typecheck: typecheckPackage(msg.files) } })
  } catch (error) {
    parentPort!.postMessage({ id: msg.id, fault: error instanceof CompilerFault ? error.message : 'check worker error' })
  }
})
