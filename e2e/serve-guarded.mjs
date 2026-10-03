// Builds and serves Scholera for browser tests with no production configuration in reach.
// Playwright's webServer runs this; nothing else should start the app for a walkthrough.
//
//   1. Copies the working tree (tracked and new files, never ignored ones such as .env*)
//      to .e2e-build/<stamp>/src, and refuses if any .env* file is there anyway.
//   2. Builds there with only the OS basics and three NEXT_PUBLIC_* values, read from
//      E2E_<NAME> and refused unless loopback and free of any production reference.
//   3. Searches .next/static and .next/server for the production project ref and any
//      hosted Supabase host, and refuses to start on a match.
//   4. Serves the standalone output from its own copy as `node server.js`, with an
//      environment built from SERVER_VARS only, never spread from process.env.
//
// The copy lives under the repo (gitignored) and leaves out the lockfile: Turbopack then
// takes the repo as its root and finds the repo's node_modules by walking up. A symlinked
// node_modules would be refused as pointing outside its root.
//
// The production ref is read from infra/app/production-project-ref, the file
// deploy-to-staging.sh reads, so the two can't drift.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILD_VARS, OPTIONAL_SERVER_VARS, SERVER_VARS, childEnv, envFilesIn, productionTraces } from './serve-guard.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function refuse(why) {
  console.error(`serve-guarded: refusing to start: ${why}`)
  process.exit(2)
}

const prodRef = readFileSync(join(repo, 'infra', 'app', 'production-project-ref'), 'utf8').trim()
if (!/^[a-z0-9]{20}$/.test(prodRef)) refuse('infra/app/production-project-ref is missing or malformed')
const port = process.env.E2E_PORT ?? '3000'
if (!/^\d{2,5}$/.test(port)) refuse('E2E_PORT is not a port')
// The Node that builds and serves: E2E_NODE (the Dockerfile's major version) or this one.
const nodeBin = process.env.E2E_NODE ?? process.execPath
if (!existsSync(nodeBin)) refuse('E2E_NODE does not exist')

const base = { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' }
const build = childEnv(process.env, BUILD_VARS, prodRef, base)
const server = childEnv(process.env, SERVER_VARS, prodRef, { ...base, PORT: port, HOSTNAME: '127.0.0.1' }, OPTIONAL_SERVER_VARS)
// Child processes the build or server starts find the same Node first.
for (const env of [build.env, server.env]) for (const k of ['PATH', 'Path']) if (env[k]) env[k] = `${dirname(nodeBin)}${delimiter}${env[k]}`
const problems = [...new Set([...build.problems, ...server.problems])]
if (problems.length) refuse(problems.join('; '))

// 1. A clean copy of the working tree.
const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' })
if (files.status !== 0) refuse('git ls-files failed')
const isEnvFile = (f) => /(^|\/)\.env[^/]*$/.test(f)
const list = files.stdout
  .split('\0')
  .filter((f) => f && !isEnvFile(f) && f !== 'package-lock.json' && !f.startsWith('.e2e-build/') && existsSync(join(repo, f)))
const digest = createHash('sha256').update(JSON.stringify(build.env))
for (const f of list) digest.update(f).update(createHash('sha1').update(readFileSync(join(repo, f))).digest('hex'))
const stamp = digest.digest('hex').slice(0, 16)
const root = join(repo, '.e2e-build', stamp)
const src = join(root, 'src')
const reuse = existsSync(join(src, '.next', 'BUILD_ID'))
if (!reuse) {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(src, { recursive: true })
  for (const f of list) {
    mkdirSync(dirname(join(src, f)), { recursive: true })
    cpSync(join(repo, f), join(src, f))
  }
}
const stray = envFilesIn(src)
if (stray.length) refuse(`the build copy holds ${stray.length} .env file(s)`)

// 2. Build with nothing but the OS basics and the loopback NEXT_PUBLIC_* values.
if (!reuse) {
  console.log(`serve-guarded: building in ${src}`)
  const built = spawnSync(nodeBin, [join(repo, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], { cwd: src, env: build.env, stdio: 'inherit' })
  if (built.status !== 0) refuse('next build failed')
}

// 3. Nothing in the output may name production.
const traces = [...productionTraces(join(src, '.next', 'static'), prodRef), ...productionTraces(join(src, '.next', 'server'), prodRef)]
if (traces.length) refuse(`the build names a production or hosted Supabase project in ${traces.length} file(s), e.g. ${traces[0]}`)

// 4. Serve the standalone output from its own copy, as the Dockerfile lays it out. With
// the repo as tracing root, server.js sits at the copy's path inside standalone/.
const serve = join(root, `serve-${process.pid}`)
rmSync(serve, { recursive: true, force: true })
cpSync(join(src, '.next', 'standalone'), serve, { recursive: true })
const findServer = (d) => {
  if (existsSync(join(d, 'server.js'))) return d
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.next') continue
    const found = findServer(join(d, e.name))
    if (found) return found
  }
  return null
}
const app = findServer(serve)
if (!app) refuse('the standalone output has no server.js')
cpSync(join(src, '.next', 'static'), join(app, '.next', 'static'), { recursive: true })
// Next's file trace copies sharp's .node binary but not the DLLs it loads beside it on Windows, so every
// route that imports sharp (the job worker among them) failed to load. Copy each missing one over.
for (const dir of [serve, app]) {
  const imgDir = join(dir, 'node_modules', '@img')
  if (!existsSync(imgDir)) continue
  for (const pkg of readdirSync(imgDir)) {
    const from = join(repo, 'node_modules', '@img', pkg, 'lib')
    if (existsSync(from)) cpSync(from, join(imgDir, pkg, 'lib'), { recursive: true, force: false })
  }
}
if (existsSync(join(src, 'public'))) cpSync(join(src, 'public'), join(app, 'public'), { recursive: true })
const strayServe = envFilesIn(serve)
if (strayServe.length) refuse(`the server copy holds ${strayServe.length} .env file(s)`)
writeFileSync(join(serve, '.serve-guarded'), stamp)

console.log(`serve-guarded: serving on http://127.0.0.1:${port}`)
const child = spawn(nodeBin, ['server.js'], { cwd: app, env: server.env, stdio: 'inherit' })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
child.on('exit', (code) => {
  rmSync(serve, { recursive: true, force: true })
  process.exit(code ?? 1)
})
