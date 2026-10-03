// Builds the Stage 2 runner for the container image (infra/validator-runner/) into
// validator-runtime/dist/, or the directory given with --out.
//
// The image runs `node dist/cloud-entry.mjs` with no TypeScript and no esbuild, so
// everything is built here:
//   cloud-entry.mjs      the entry, runner.mjs, binding.mjs, frame-document.ts and
//                        limits.ts in one file
//   host.js              the validator host page's script (host-entry.ts), prebuilt
//   studio-runtime/v1/   runtime.js, vendor.js and kit.css, copied as is
//   axe.min.js           axe-core, copied as is
//   node_modules/playwright-core
//                        the browser driver, copied from this checkout so its version
//                        matches the lockfile and the Playwright base image
//
// Usage: node validator-runtime/build.mjs [--out <dir>]
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { hostScript } from './runner.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)

const outFlag = process.argv.indexOf('--out')
const out = outFlag > 0 && process.argv[outFlag + 1] ? resolve(process.argv[outFlag + 1]) : join(here, 'dist')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

writeFileSync(join(out, 'host.js'), await hostScript())

await build({
  entryPoints: [join(here, 'cloud-entry.mjs')],
  outfile: join(out, 'cloud-entry.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // runner.mjs imports Playwright through @playwright/test; the container needs only
  // the driver, which playwright-core exports under the same names.
  alias: { '@playwright/test': 'playwright-core' },
  // playwright-core ships beside the bundle. esbuild is never reached when prebuilt.
  external: ['playwright-core', 'esbuild'],
  define: { __STUDIO_VALIDATOR_PREBUILT__: 'true' },
  tsconfig: join(repo, 'tsconfig.json'),
  logLevel: 'error',
})

for (const asset of ['runtime.js', 'vendor.js', 'kit.css']) {
  cpSync(join(repo, 'public', 'studio-runtime', 'v1', asset), join(out, 'studio-runtime', 'v1', asset))
}
cpSync(require.resolve('axe-core/axe.min.js'), join(out, 'axe.min.js'))
cpSync(dirname(require.resolve('playwright-core/package.json')), join(out, 'node_modules', 'playwright-core'), { recursive: true })

console.log(`validator runner built into ${out}`)
