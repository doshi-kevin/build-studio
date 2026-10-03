// Stage 2 runner, local mode. Reads one payload (binding.mjs) on stdin, runs it, and
// prints the envelope { binding, report } as JSON on stdout. Spawned by
// src/lib/studio/validator/runtime-runner.ts with a minimal environment. The container
// entry (cloud-entry.mjs) implements the same contract over signed URLs.
//
// Exit codes: 0 with the envelope on stdout, 2 for a payload that is too large or
// invalid (nothing printed), 1 for any other failure.
import { buildEnvelope, PAYLOAD_MAX_BYTES, parsePayload } from './binding.mjs'

const chunks = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > PAYLOAD_MAX_BYTES) process.exit(2)
  chunks.push(chunk)
}

const parsed = parsePayload(Buffer.concat(chunks))
if (!parsed.ok) process.exit(2)

try {
  const { runRuntimeValidation } = await import('./runner.mjs')
  const { manifest, studentBundle, professorBundle } = parsed.payload
  const report = await runRuntimeValidation({ manifest, studentBundle, professorBundle })
  // Exit only once the envelope is flushed: pipes are asynchronous on some platforms.
  process.stdout.write(JSON.stringify(buildEnvelope(parsed.payload, parsed.payloadSha256, report)), () => process.exit(0))
} catch {
  process.exit(1)
}
