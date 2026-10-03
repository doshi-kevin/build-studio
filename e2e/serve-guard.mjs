// The checks e2e/serve-guarded.mjs runs before it builds or serves anything. Pure, so the
// unit suite tests them (src/__tests__/e2e-serve-guard.test.ts).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Variables the server must receive, each read only from E2E_<NAME> in the caller's env. */
export const SERVER_VARS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SITE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
/** Variables it may receive when the caller sets them, checked the same way. The Gemini key is the one
 * outside credential a walkthrough may pass on purpose, so Studio's builder can call a model. */
export const OPTIONAL_SERVER_VARS = ['BACKGROUND_JOBS_SECRET', 'STUDIO_FRAME_TICKET_SECRET', 'STUDIO_RUNTIME_ORIGIN', 'STUDIO_STUDENT_ACCESS', 'GOOGLE_GENERATIVE_AI_API_KEY']
/** The subset baked into the client bundle at build time. */
export const BUILD_VARS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SITE_URL']
/** Enough of the OS environment to find node and a temp directory; nothing else. */
const OS_VARS = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ComSpec']

export function isLoopbackUrl(value) {
  try {
    const u = new URL(value)
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

/** Why a value can't be used, or null. URLs must be loopback; nothing may name production. */
export function refuseValue(name, value, prodRef) {
  if (typeof value !== 'string' || value.length === 0) return `${name} is not set`
  if (value.includes(prodRef)) return `${name} names the production project`
  if (/\.supabase\.co/i.test(value)) return `${name} names a hosted Supabase project`
  if ((name.endsWith('_URL') || name.endsWith('_ORIGIN')) && !isLoopbackUrl(value)) return `${name} is not a loopback URL`
  return null
}

/** The environment for a child: the OS basics plus exactly `names` (and any of `optional`
 * the caller set), read from E2E_<name>. Never anything else from `source`. */
export function childEnv(source, names, prodRef, extra = {}, optional = []) {
  const env = {}
  for (const k of OS_VARS) if (typeof source[k] === 'string') env[k] = source[k]
  const problems = []
  for (const name of [...names, ...optional.filter((n) => source[`E2E_${n}`] !== undefined)]) {
    const value = source[`E2E_${name}`]
    const why = refuseValue(name, value, prodRef)
    if (why) problems.push(why)
    else env[name] = value
  }
  return { env: { ...env, ...extra }, problems }
}

/** Every `.env*` file under `dir`, not descending into node_modules or build output. */
export function envFilesIn(dir) {
  const found = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (basename(p).startsWith('.env')) found.push(p)
    }
  }
  walk(dir)
  return found
}

/**
 * The one production URL the app hard-codes on purpose: public, read-only landing-page
 * videos (src/components/landing/DeskFilm.tsx, OutroFilm.tsx). Not configuration and no
 * credential. Exactly this prefix is ignored; any other mention still refuses.
 */
export const publicLandingAssets = (prodRef) => `https://${prodRef}.supabase.co/storage/v1/object/public/landing-assets/`

/** Files under `dir` whose text names the production project or any hosted Supabase host. */
export function productionTraces(dir, prodRef) {
  const allowed = publicLandingAssets(prodRef)
  const hits = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (statSync(p).size < 50 * 1024 * 1024) {
        const text = readFileSync(p, 'latin1').split(allowed).join('')
        if (text.includes(prodRef) || /[a-z0-9]{20}\.supabase\.co/i.test(text)) hits.push(p)
      }
    }
  }
  walk(dir)
  return hits
}
