// Stage 2 runner entry point: reads one artifact as JSON on stdin
// ({ manifest, studentBundle, professorBundle }), runs it, prints the report as JSON on
// stdout. Spawned by src/lib/studio/validator/runtime-runner.ts with a minimal
// environment; the same contract a production container would implement.
import { runRuntimeValidation } from './runner.mjs'

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) {
  input += chunk
  if (input.length > 2 * 1024 * 1024) process.exit(2)
}

try {
  const artifact = JSON.parse(input)
  if (typeof artifact?.studentBundle !== 'string' || typeof artifact?.professorBundle !== 'string') process.exit(2)
  const report = await runRuntimeValidation(artifact)
  process.stdout.write(JSON.stringify(report))
  process.exit(0)
} catch {
  process.exit(1)
}
