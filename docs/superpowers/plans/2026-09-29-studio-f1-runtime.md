# Studio F1: Plugin Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any plugin, meaning a feature a professor builds in Studio, can be stored in their course as a frozen version and run inside Studio, isolated in a sandboxed frame, styled like Scholera, and talking to the platform only through a checked bridge. Studio ships **no built-in plugins**: professors build their own. F1 proves the runtime with one internal test plugin that only tests and a local dev script use.

**Architecture:** Plugin code is data: a frozen version row holds the compiled bundle and its manifest. The browser runs it in an `<iframe sandbox="allow-scripts">` built from injected HTML, with a content security policy that blocks every network request. The plugin reaches Scholera only by `postMessage` to the host component, which validates each call and forwards server capabilities to one server action that re-checks everything.

**Tech Stack:** Next.js 16 server components and server actions, React 19, Supabase Postgres (row-level security, one timestamped migration), Zod, esbuild 0.27.3 for the runtime and plugin bundles, Vitest (unit tier and the real-Postgres `test:db` tier), Playwright driving Edge for the browser check.

**Source documents:** `docs/reference/studio-plugin-rules.md` (the canonical rules; numbers below cite it), `docs/reference/studio-plugin-manifest.md` (the manifest contract) and `docs/designs/studio/studio-runtime.md` (design sketch, gitignored and local only). This plan says how to build; it doesn't define rules. Where it disagrees with the rules doc, the rules doc wins.

> **Reconciliation (2026-09-30). Read before executing any task below.** Rules doc version 2 changed the model this plan was written against:
> - **Project, version and installation are separate.** One version can be installed in several sections, and each installation belongs to one section (rule 2.4). Task 3's `studio_plugins` row (one plugin per section) and its migration are superseded by Step 2A's database design. Don't run Task 3 as written.
> - **Capability approval belongs to the installation, not the version** (rule 1.5). `approved_capabilities` and `approved_by` move off `studio_plugin_versions`. Tasks 7 and 8 check approval against the installation.
> - **The manifest is the one in `studio-plugin-manifest.md`.** It has per-view capabilities and no top-level `capabilities` list. Task 1 is done (see its note).
> - **Task 7 is partly superseded by Step 3B.** Data access goes through `src/lib/studio/records.ts` and `lifecycle.ts` (`docs/reference/studio-plugin-server.md`). `callPluginCapability` must call those, never query `studio_plugin_*` itself; a tripwire test refuses it.
> - **Network isolation needs more than the sandbox and `connect-src`.** Task 2's frame builder must meet N1 to N11 in the rules doc appendix, and Task 9 must probe each of them.

**Repository rules that apply throughout:**
- Work on `feature/studio`. Never commit or push unless the user asks. Where a task says **Checkpoint**, stop, run the checks, and offer a commit.
- Migrations are applied to the LOCAL Supabase only (running in WSL `Ubuntu-Scholera`). Never run anything against the production project `ywdqaoahfmmzcsczxvxn`.
- No `any` casts to silence errors, no `eslint-disable` except the existing pattern `// eslint-disable-next-line @typescript-eslint/no-explicit-any` on admin-client handles, which the codebase already uses for `createAdminClient()`.
- UI: semantic tokens only, radius classes `rounded-xl`/`rounded-2xl`/`rounded-3xl`/`rounded-full`, 44px touch targets.

---

## Decisions locked in by this plan

| Decision | Choice |
|---|---|
| Built-in plugins | **None.** No gallery and no templates. One internal test plugin, `bridge-check`, lives in `src/lib/studio/fixtures/`. It's installed into a local course only by `scripts/dev-setup/studio-install-fixture.mjs`, which refuses any non-local database. In production, only Athena's builder creates plugins (a later step). |
| Client access to the new tables | **None.** Row-level security on, no policies, `revoke all` from `anon` and `authenticated`. Every read and write goes through a server action after `verifySectionAccess`. (Graders are admitted by `verifySectionAccess` but not by `is_section_owner_or_staff`, so a client policy would silently exclude them.) |
| How plugin code imports the SDK | Plugins import `@/lib/studio/runtime/sdk` and `react`. The plugin build maps those imports to `window.ScholeraStudio` globals, so no `tsconfig.json` change is needed. |
| How the frame gets code | The runtime loads from `/studio-runtime/v1/runtime.js`. The plugin's compiled code is inlined in a `<script nonce>` with every `</script` escaped. |
| Dark mode | The app has none, so none is mirrored. The frame uses the app's own stylesheet. |
| Fonts | The frame copies `<body>` classes, which carry the `next/font` variables. If the fonts fail to load cross-origin (fonts are fetched with CORS and a sandboxed frame's origin is `null`), Task 9 adds one header for font files. |
| Limits (rule 10.2) | `STUDIO_PLUGIN_MAX_BYTES = 256 * 1024`, `STUDIO_BRIDGE_CALLS_PER_MINUTE = 120` |

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/<ts>_studio_plugins.sql` | `studio_plugins`, `studio_plugin_versions`, RLS, revokes, immutability trigger |
| `src/lib/studio/limits.ts` | Named limits |
| `src/lib/studio/capabilities.ts` | Capability names, which side runs them, argument schemas, plain-language labels |
| `src/lib/studio/manifest.ts` | Manifest v1 schema and type |
| `src/lib/studio/protocol.ts` | Bridge message shapes and parsers (both sides) |
| `src/lib/studio/rate-limit.ts` | Per-frame token bucket (pure) |
| `src/lib/studio/srcdoc.ts` | Builds the frame HTML and its content security policy (pure) |
| `src/lib/studio/queries.ts` | Studio reads (queries.ts conventions, own file by decision) |
| `src/lib/studio/capability-handlers.ts` | Server-only handlers for `context.get`, `course.skills` |
| `src/lib/studio/fixtures/bridge-check/plugin.tsx` + `manifest.json` | Internal test plugin exercising every v1 capability. Never shown to professors |
| `scripts/dev-setup/studio-install-fixture.mjs` | Local-only: installs the test plugin into a local course section |
| `src/lib/studio/runtime/bridge-client.ts` | In-frame request/response over `postMessage` |
| `src/lib/studio/runtime/sdk.ts` | What plugins import: kit, hooks, `toast` |
| `src/lib/studio/runtime/entry.tsx` | In-frame bootstrap: exposes globals, mounts the plugin, auto-resizes |
| `src/components/studio/kit/*.tsx` | Plugin kit: layout primitives plus re-exported shadcn components with no Next.js dependencies |
| `scripts/build-studio-runtime.mjs` | esbuild: runtime + the test plugin to `public/studio-runtime/v1/` |
| `src/app/(dashboard)/professor/courses/[sectionId]/studio/actions.ts` | `archivePlugin`, `callPluginCapability` |
| `src/components/studio/host/PluginHost.tsx` | Client host: builds the frame, validates messages, throttles, calls the action |
| `src/components/studio/InstalledPlugins.tsx` | "In this course" list |
| `src/app/(dashboard)/professor/courses/[sectionId]/studio/page.tsx` | Modify: add the installed list above the builder shell |
| `src/app/(dashboard)/professor/courses/[sectionId]/studio/[pluginId]/page.tsx` | Runs one installed plugin |
| Tests: `src/__tests__/studio-*.test.ts`, `src/__tests__/db/studio-plugins.test.ts` | See each task |
| `package.json`, `package-lock.json`, `.gitignore` | Build hook, esbuild dev dependency, ignore generated runtime |

---

### Task 1: Limits, capabilities and the manifest schema

> **Superseded (2026-09-30).** Implemented with a fuller contract: `docs/reference/studio-plugin-manifest.md`, tested by `src/__tests__/studio-manifest.test.ts`. The manifest now has `manifestVersion`, `id`, `version`, per-view `entry` and `capabilities`, and `collections`. `STUDIO_BRIDGE_VERSIONS` lives in `manifest.ts`, capabilities carry `views` but no argument schemas yet (those land with Task 2's bridge), and `parseManifest` returns `issues`. Later tasks that build a manifest must use that shape. The steps below are kept for history.

**Files:**
- Create: `src/lib/studio/limits.ts`, `src/lib/studio/capabilities.ts`, `src/lib/studio/manifest.ts`
- Test: `src/__tests__/studio-manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { parseManifest } from '@/lib/studio/manifest'
import { CAPABILITIES, parseCapabilityArgs } from '@/lib/studio/capabilities'

const valid = {
  name: 'Bridge check',
  description: 'Internal test plugin.',
  bridgeVersion: 'v1',
  capabilities: ['context.get', 'course.skills', 'ui.resize'],
}

describe('manifest v1', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseManifest(valid)).toMatchObject({ ok: true })
  })
  it('rejects an unknown capability', () => {
    expect(parseManifest({ ...valid, capabilities: ['network.fetch'] })).toMatchObject({ ok: false })
  })
  it('rejects extra fields (the platform trusts only what it declared)', () => {
    expect(parseManifest({ ...valid, secretKey: 'x' })).toMatchObject({ ok: false })
  })
  it('rejects a bridge version the platform does not serve', () => {
    expect(parseManifest({ ...valid, bridgeVersion: 'v9' })).toMatchObject({ ok: false })
  })
})

describe('capability arguments (rule 2.1: no identifiers)', () => {
  it('course.skills takes no arguments at all', () => {
    expect(parseCapabilityArgs('course.skills', {})).toMatchObject({ ok: true })
    expect(parseCapabilityArgs('course.skills', { sectionId: 'x' })).toMatchObject({ ok: false })
  })
  it('ui.toast caps message length', () => {
    expect(parseCapabilityArgs('ui.toast', { message: 'Saved' })).toMatchObject({ ok: true })
    expect(parseCapabilityArgs('ui.toast', { message: 'x'.repeat(201) })).toMatchObject({ ok: false })
  })
  it('every capability has a label a professor can read', () => {
    for (const c of CAPABILITIES) expect(c.label.length).toBeGreaterThan(5)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/__tests__/studio-manifest.test.ts`
Expected: FAIL, cannot resolve `@/lib/studio/manifest`.

- [ ] **Step 3: Implement**

`src/lib/studio/limits.ts`:
```ts
/** Plugin rule 10.1: every limit is a named platform setting. */
export const STUDIO_PLUGIN_MAX_BYTES = 256 * 1024
export const STUDIO_BRIDGE_CALLS_PER_MINUTE = 120
export const STUDIO_BRIDGE_VERSIONS = ['v1'] as const
```

`src/lib/studio/capabilities.ts`:
```ts
import { z } from 'zod'

// Args are strict objects with no identifier fields (plugin rule 2.1). The section,
// user and institution always come from the server's own lookup, never the plugin.
const ARG_SCHEMAS = {
  'context.get': z.object({}).strict(),
  'course.skills': z.object({}).strict(),
  'ui.resize': z.object({ height: z.number().int().min(0).max(20000) }).strict(),
  'ui.toast': z.object({ message: z.string().min(1).max(200), tone: z.enum(['info', 'success', 'error']).optional() }).strict(),
} as const

export type CapabilityName = keyof typeof ARG_SCHEMAS

export const CAPABILITIES: { name: CapabilityName; runs: 'server' | 'host'; label: string }[] = [
  { name: 'context.get', runs: 'server', label: 'See this course’s name and your role in it' },
  { name: 'course.skills', runs: 'server', label: 'Read this course’s skill list' },
  { name: 'ui.resize', runs: 'host', label: 'Fit itself to the page' },
  { name: 'ui.toast', runs: 'host', label: 'Show short notifications' },
]

export const CAPABILITY_NAMES = CAPABILITIES.map((c) => c.name) as [CapabilityName, ...CapabilityName[]]

export function isServerCapability(name: CapabilityName): boolean {
  return CAPABILITIES.find((c) => c.name === name)!.runs === 'server'
}

export function isCapabilityName(name: unknown): name is CapabilityName {
  return typeof name === 'string' && name in ARG_SCHEMAS
}

export function parseCapabilityArgs<N extends CapabilityName>(
  name: N,
  args: unknown,
): { ok: true; args: z.infer<(typeof ARG_SCHEMAS)[N]> } | { ok: false } {
  const result = ARG_SCHEMAS[name].safeParse(args)
  return result.success ? { ok: true, args: result.data as z.infer<(typeof ARG_SCHEMAS)[N]> } : { ok: false }
}
```

`src/lib/studio/manifest.ts`:
```ts
import { z } from 'zod'
import { CAPABILITY_NAMES } from './capabilities'
import { STUDIO_BRIDGE_VERSIONS } from './limits'

export const manifestSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
    bridgeVersion: z.enum(STUDIO_BRIDGE_VERSIONS),
    capabilities: z.array(z.enum(CAPABILITY_NAMES)).max(20),
  })
  .strict()

export type StudioManifest = z.infer<typeof manifestSchema>

export function parseManifest(raw: unknown): { ok: true; manifest: StudioManifest } | { ok: false } {
  const result = manifestSchema.safeParse(raw)
  return result.success ? { ok: true, manifest: result.data } : { ok: false }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/__tests__/studio-manifest.test.ts`
Expected: PASS (7 tests).

---

### Task 2: Bridge protocol, rate limiter and frame HTML

**Files:**
- Create: `src/lib/studio/protocol.ts`, `src/lib/studio/rate-limit.ts`, `src/lib/studio/srcdoc.ts`
- Test: `src/__tests__/studio-bridge-pure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { parseFrameMessage } from '@/lib/studio/protocol'
import { createBucket } from '@/lib/studio/rate-limit'
import { buildSrcdoc } from '@/lib/studio/srcdoc'

describe('parseFrameMessage', () => {
  it('accepts a well-formed call', () => {
    expect(parseFrameMessage({ type: 'studio:call', id: 'a1', capability: 'course.skills', args: {} })).toMatchObject({
      kind: 'call',
      capability: 'course.skills',
    })
  })
  it('rejects unknown capabilities and junk', () => {
    expect(parseFrameMessage({ type: 'studio:call', id: 'a1', capability: 'db.query', args: {} })).toBeNull()
    expect(parseFrameMessage('hello')).toBeNull()
    expect(parseFrameMessage({ type: 'studio:call', id: 'x'.repeat(100), capability: 'context.get', args: {} })).toBeNull()
  })
})

describe('rate limiter', () => {
  it('allows the budget, then refuses, then refills', () => {
    let now = 0
    const bucket = createBucket(3, () => now)
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false])
    now += 60_000
    expect(bucket.take()).toBe(true)
  })
})

describe('buildSrcdoc (rules 1.1-1.3)', () => {
  const html = buildSrcdoc({
    origin: 'https://app.example',
    nonce: 'n0nce',
    stylesheets: ['https://app.example/_next/static/chunks/app.css'],
    bodyClass: 'font-vars antialiased',
    pluginCode: 'window.__scholeraPlugin={};"</script><script>alert(1)</script>"',
  })
  it('blocks every network request type', () => {
    for (const d of ["connect-src 'none'", "img-src 'none'", "frame-src 'none'", "form-action 'none'", "default-src 'none'"]) {
      expect(html).toContain(d)
    }
  })
  it('allows scripts only from the runtime path and the nonce', () => {
    expect(html).toContain("script-src https://app.example/studio-runtime/v1/runtime.js 'nonce-n0nce'")
  })
  it('cannot be broken out of by plugin code containing </script>', () => {
    const inline = html.slice(html.indexOf('nonce="n0nce">'))
    expect(inline.indexOf('</script>')).toBe(inline.lastIndexOf('</script>'))
  })
  it('escapes attribute values', () => {
    const h = buildSrcdoc({ origin: 'https://a', nonce: 'n', stylesheets: ['https://a/x.css"><script>'], bodyClass: '"x', pluginCode: '' })
    expect(h).not.toContain('"><script>')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/__tests__/studio-bridge-pure.test.ts` — Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`src/lib/studio/protocol.ts`:
```ts
import { isCapabilityName, type CapabilityName } from './capabilities'

/** Frame to host. */
export type FrameMessage =
  | { kind: 'ready' }
  | { kind: 'call'; id: string; capability: CapabilityName; args: unknown }

/** Host to frame. */
export type HostMessage =
  | { type: 'studio:init'; bridgeVersion: 'v1' }
  | { type: 'studio:result'; id: string; ok: true; data: unknown }
  | { type: 'studio:result'; id: string; ok: false; error: string }

const ID = /^[A-Za-z0-9_-]{1,64}$/

export function parseFrameMessage(raw: unknown): FrameMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.type === 'studio:ready') return { kind: 'ready' }
  if (m.type !== 'studio:call') return null
  if (typeof m.id !== 'string' || !ID.test(m.id)) return null
  if (!isCapabilityName(m.capability)) return null
  return { kind: 'call', id: m.id, capability: m.capability, args: m.args ?? {} }
}
```

`src/lib/studio/rate-limit.ts`:
```ts
/** Per-frame budget. The frame can only reach the server through the host, so this binds it. */
export function createBucket(perMinute: number, now: () => number = Date.now) {
  let tokens = perMinute
  let last = now()
  return {
    take(): boolean {
      const t = now()
      tokens = Math.min(perMinute, tokens + ((t - last) / 60_000) * perMinute)
      last = t
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}
```

`src/lib/studio/srcdoc.ts`:
```ts
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface SrcdocInput {
  origin: string
  nonce: string
  stylesheets: string[]
  bodyClass: string
  pluginCode: string
}

/** The whole frame document. Plugin rules 1.1-1.3: scripts only from the runtime file and
 * the nonce, styles and fonts only from Scholera, and every request type blocked. */
export function buildSrcdoc({ origin, nonce, stylesheets, bodyClass, pluginCode }: SrcdocInput): string {
  const runtime = `${origin}/studio-runtime/v1/runtime.js`
  const csp = [
    "default-src 'none'",
    `script-src ${runtime} 'nonce-${nonce}'`,
    `style-src ${origin} 'unsafe-inline'`,
    `font-src ${origin}`,
    "img-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
  const code = pluginCode.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">`,
    ...stylesheets.map((href) => `<link rel="stylesheet" href="${attr(href)}">`),
    `</head><body class="${attr(bodyClass)} bg-background text-foreground"><div id="root"></div>`,
    `<script src="${attr(runtime)}"></script>`,
    `<script nonce="${attr(nonce)}">${code}</script>`,
    '</body></html>',
  ].join('')
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run src/__tests__/studio-bridge-pure.test.ts` — Expected: PASS (7 tests).

- [ ] **Step 5: Checkpoint.** Run `npx eslint src/lib/studio` and `npm run typecheck`. Offer a commit: `feat(studio): manifest, capabilities and sandbox frame builder`.

---

### Task 3: Migration for plugin storage

> **Superseded by Step 2A (2026-09-30).** The schema below stores one plugin per section and puts capability approval on the version. Both contradict rules 1.5 and 2.4. Kept for history; don't run it. Implemented instead by `supabase/migrations/20260930175948_studio_plugin_storage.sql`, tested by `src/__tests__/db/studio-storage.test.ts`. Tasks 7 and 8 must read the installation and its current version from those tables.

**Files:**
- Create: `supabase/migrations/<timestamp>_studio_plugins.sql` (via the CLI)
- Test: `src/__tests__/db/studio-plugins.test.ts`

- [ ] **Step 1: Create the migration file with the CLI (timestamped, never hand-numbered)**

Write `C:\wsl-images\new-migration.sh`:
```bash
#!/bin/bash
set -e
cd /mnt/c/Projects/Scholera/Scholera-prod
supabase migration new studio_plugins
```
Run: `powershell.exe -NoProfile -Command 'wsl -d Ubuntu-Scholera -- bash /mnt/c/wsl-images/new-migration.sh'`
Expected: `Created new migration at supabase/migrations/<timestamp>_studio_plugins.sql`

- [ ] **Step 2: Write the migration**

```sql
-- Studio plugins: one row per plugin installed in a course section, plus its
-- frozen versions. Plugin code is data here, never part of the app deploy.
--
-- Client roles get NOTHING on these tables: RLS is on with no policies, and the
-- default Supabase grants are revoked. Every read and write goes through a server
-- action after verifySectionAccess, which admits professors, TAs and graders.
-- A client policy on is_section_owner_or_staff would silently exclude graders.

create table if not exists public.studio_plugins (
  id              uuid primary key default gen_random_uuid(),
  institution_id  uuid not null references public.institutions(id) on delete cascade,
  section_id      uuid not null references public.course_sections(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80),
  status          text not null default 'installed' check (status in ('installed', 'archived')),
  current_version integer not null default 1 check (current_version >= 1),
  created_by      uuid not null references public.profiles(id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_studio_plugins_section on public.studio_plugins (section_id, status);

create table if not exists public.studio_plugin_versions (
  id                    uuid primary key default gen_random_uuid(),
  plugin_id             uuid not null references public.studio_plugins(id) on delete cascade,
  institution_id        uuid not null references public.institutions(id) on delete cascade,
  version               integer not null check (version >= 1),
  manifest              jsonb not null,
  code                  text not null,
  code_sha256           text not null,
  bridge_version        text not null check (bridge_version in ('v1')),
  approved_capabilities text[] not null default '{}',
  approved_by           uuid not null references public.profiles(id) on delete restrict,
  created_at            timestamptz not null default now(),
  unique (plugin_id, version)
);

alter table public.studio_plugins enable row level security;
alter table public.studio_plugin_versions enable row level security;

revoke all on table public.studio_plugins from anon, authenticated;
revoke all on table public.studio_plugin_versions from anon, authenticated;

-- Plugin rule 8.4: a published version is frozen, even against our own server code.
create or replace function public.studio_plugin_versions_immutable()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  raise exception 'studio_plugin_versions rows are immutable; insert a new version instead'
    using errcode = 'check_violation';
end;
$$;

revoke execute on function public.studio_plugin_versions_immutable() from public, anon, authenticated;

drop trigger if exists trg_studio_plugin_versions_immutable on public.studio_plugin_versions;
create trigger trg_studio_plugin_versions_immutable
  before update on public.studio_plugin_versions
  for each row execute function public.studio_plugin_versions_immutable();

-- A plugin's rows must stay in its section's institution.
create or replace function public.studio_plugins_tenant_match()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from public.course_sections cs
     where cs.id = new.section_id and cs.institution_id = new.institution_id
  ) then
    raise exception 'studio_plugins.institution_id must match its section' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.studio_plugins_tenant_match() from public, anon, authenticated;

drop trigger if exists trg_studio_plugins_tenant_match on public.studio_plugins;
create trigger trg_studio_plugins_tenant_match
  before insert or update of section_id, institution_id on public.studio_plugins
  for each row execute function public.studio_plugins_tenant_match();
```

- [ ] **Step 3: Apply it to the LOCAL database only**

Write `C:\wsl-images\migrate-local.sh`:
```bash
#!/bin/bash
set -e
cd /mnt/c/Projects/Scholera/Scholera-prod
supabase migration up --local
```
Run: `powershell.exe -NoProfile -Command 'wsl -d Ubuntu-Scholera -- bash /mnt/c/wsl-images/migrate-local.sh'`
Expected: `Applying migration <timestamp>_studio_plugins.sql...` then `Local database is up to date.`

- [ ] **Step 4: Write the real-Postgres test**

`src/__tests__/db/studio-plugins.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { FIXTURE, serviceClient } from './fixture'
import { asUser, asAnon } from './clients'

const A = FIXTURE.a
const service = serviceClient()
let pluginId = ''

beforeAll(async () => {
  const { data, error } = await service
    .from('studio_plugins')
    .insert({ institution_id: A.institution, section_id: A.section, name: 'Fixture plugin', created_by: A.users.professor.id })
    .select('id')
    .single()
  if (error) throw error
  pluginId = data.id
  const { error: vErr } = await service.from('studio_plugin_versions').insert({
    plugin_id: pluginId, institution_id: A.institution, version: 1,
    manifest: { name: 'x' }, code: '', code_sha256: 'x', bridge_version: 'v1', approved_by: A.users.professor.id,
  })
  if (vErr) throw vErr
})

describe('studio tables are server-only', () => {
  it('the rows exist (so an empty read below is a real denial)', async () => {
    const { data } = await service.from('studio_plugins').select('id').eq('id', pluginId)
    expect(data).toHaveLength(1)
  })

  for (const role of ['professor', 'ta', 'student'] as const) {
    it(`${role} of the same section cannot read either table directly`, async () => {
      const client = await asUser(A.users[role].email)
      const plugins = await client.from('studio_plugins').select('id')
      const versions = await client.from('studio_plugin_versions').select('id')
      expect(plugins.error?.code).toBe('42501')
      expect(versions.error?.code).toBe('42501')
    })
  }

  it('anon cannot read', async () => {
    const { error } = await asAnon().from('studio_plugins').select('id')
    expect(error?.code).toBe('42501')
  })
})

describe('versions are frozen (rule 8.4)', () => {
  it('rejects an update even from the service role', async () => {
    const { error } = await service.from('studio_plugin_versions').update({ code: 'changed' }).eq('plugin_id', pluginId)
    expect(error?.message).toMatch(/immutable/)
  })
})

describe('tenant match', () => {
  it('refuses a plugin whose institution differs from its section', async () => {
    const { error } = await service.from('studio_plugins').insert({
      institution_id: FIXTURE.b.institution, section_id: A.section, name: 'Cross-tenant', created_by: A.users.professor.id,
    })
    expect(error?.message).toMatch(/must match its section/)
  })
})
```

Check the fixture's user shape first: `grep -n "users" src/__tests__/db/fixture.ts`. If users expose `email` differently, adapt the two `A.users[role].email` references to the fixture's actual field.

- [ ] **Step 5: Run the database tier against the local stack**

Run: `npx dotenv -e .env.local -e .env -- npm run test:db -- src/__tests__/db/studio-plugins.test.ts` (and read `src/__tests__/db/env.ts` first for any extra env it needs).
Expected: PASS (7 tests). Then run the whole tier: `npx dotenv -e .env.local -e .env -- npm run test:db`. The catalog sweep in `grants-and-policy-shape.test.ts` must stay green.

- [ ] **Step 6: Checkpoint.** Offer a commit: `feat(studio): server-only plugin tables with frozen versions`.

---

### Task 4: The plugin kit

**Files:**
- Create: `src/components/studio/kit/layout.tsx`, `src/components/studio/kit/index.ts`

Rules: no `next/*` imports anywhere in the kit (it is bundled into the frame). Class names are fixed maps, so Tailwind emits them from `src/` like any other component.

- [ ] **Step 1: Write the layout primitives**

`src/components/studio/kit/layout.tsx`:
```tsx
import { cn } from '@/lib/utils'

const GAP = { 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4', 6: 'gap-6', 8: 'gap-8' } as const
type Gap = keyof typeof GAP

export function Stack({ gap = 4, direction = 'column', align, children }: {
  gap?: Gap
  direction?: 'row' | 'column'
  align?: 'start' | 'center' | 'end' | 'between'
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex',
        direction === 'row' ? 'flex-row flex-wrap items-center' : 'flex-col',
        GAP[gap],
        align === 'center' && 'items-center justify-center',
        align === 'end' && 'items-end justify-end',
        align === 'between' && 'justify-between',
      )}
    >
      {children}
    </div>
  )
}

const COLS = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4' } as const

export function Grid({ columns = 2, gap = 4, children }: { columns?: keyof typeof COLS; gap?: Gap; children: React.ReactNode }) {
  return <div className={cn('grid grid-cols-1', COLS[columns], GAP[gap])}>{children}</div>
}

export function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl bg-card p-6 shadow-sm">{children}</div>
}

const TEXT = {
  body: 'text-sm text-foreground',
  muted: 'text-sm text-muted-foreground',
  lead: 'text-base text-foreground',
  number: 'font-mono text-5xl font-semibold tabular-nums',
} as const

export function Text({ tone = 'body', children }: { tone?: keyof typeof TEXT; children: React.ReactNode }) {
  return <p className={TEXT[tone]}>{children}</p>
}

export function Heading({ level = 2, children }: { level?: 2 | 3; children: React.ReactNode }) {
  return level === 2 ? (
    <h2 className="font-[family-name:var(--font-instrument-serif)] text-2xl">{children}</h2>
  ) : (
    <h3 className="text-base font-semibold">{children}</h3>
  )
}

export function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-4 py-12 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
```

`src/components/studio/kit/index.ts`:
```ts
export { Stack, Grid, Panel, Text, Heading, Empty } from './layout'
export { Button } from '@/components/ui/button'
export { Input } from '@/components/ui/input'
export { Label } from '@/components/ui/label'
export { Textarea } from '@/components/ui/textarea'
export { Badge } from '@/components/ui/badge'
export { Switch } from '@/components/ui/switch'
export { Skeleton } from '@/components/ui/skeleton'
```

- [ ] **Step 2: Confirm the re-exported components have no Next.js imports**

Run: `grep -n "from 'next" src/components/ui/{button,input,label,textarea,badge,switch,skeleton}.tsx`
Expected: no output. If any line appears, drop that component from `index.ts`.

---

### Task 5: In-frame runtime, SDK and the test plugin

**Files:**
- Create: `src/lib/studio/runtime/bridge-client.ts`, `src/lib/studio/runtime/sdk.ts`, `src/lib/studio/runtime/entry.tsx`
- Create: `src/lib/studio/fixtures/bridge-check/plugin.tsx`, `src/lib/studio/fixtures/bridge-check/manifest.json`

- [ ] **Step 1: Bridge client (runs inside the frame)**

`src/lib/studio/runtime/bridge-client.ts`:
```ts
import type { CapabilityName } from '@/lib/studio/capabilities'
import type { HostMessage } from '@/lib/studio/protocol'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
const pending = new Map<string, Pending>()
let seq = 0
let ready: Promise<void> | null = null

function onMessage(event: MessageEvent) {
  if (event.source !== window.parent) return
  const msg = event.data as HostMessage
  if (!msg || msg.type !== 'studio:result') return
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.ok) p.resolve(msg.data)
  else p.reject(new Error(msg.error))
}

export function connect(): Promise<void> {
  if (ready) return ready
  ready = new Promise((resolve) => {
    window.addEventListener('message', onMessage)
    const onInit = (event: MessageEvent) => {
      if (event.source !== window.parent || (event.data as HostMessage)?.type !== 'studio:init') return
      window.removeEventListener('message', onInit)
      resolve()
    }
    window.addEventListener('message', onInit)
    window.parent.postMessage({ type: 'studio:ready' }, '*')
  })
  return ready
}

export async function call<T = unknown>(capability: CapabilityName, args: Record<string, unknown> = {}): Promise<T> {
  await connect()
  const id = `c${++seq}`
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (v) => resolve(v as T), reject })
    window.parent.postMessage({ type: 'studio:call', id, capability, args }, '*')
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('Scholera did not answer in time.'))
    }, 15_000)
  })
}
```

- [ ] **Step 2: SDK (what plugins import)**

`src/lib/studio/runtime/sdk.ts`:
```ts
import { useEffect, useState } from 'react'
import type { CapabilityName } from '@/lib/studio/capabilities'
import { call } from './bridge-client'

export * from '@/components/studio/kit'
export { call }

export interface CourseContext { role: 'professor' | 'assistant'; course: { title: string; code: string } }
export interface CourseSkill { name: string; parent: string | null }

export function useCapability<T>(capability: CapabilityName, args: Record<string, unknown> = {}) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null, error: null, loading: true,
  })
  const key = JSON.stringify(args)
  useEffect(() => {
    let live = true
    call<T>(capability, JSON.parse(key))
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e: Error) => live && setState({ data: null, error: e.message, loading: false }))
    return () => {
      live = false
    }
  }, [capability, key])
  return state
}

export function toast(message: string, tone: 'info' | 'success' | 'error' = 'info') {
  void call('ui.toast', { message, tone })
}
```

- [ ] **Step 3: Runtime entry**

`src/lib/studio/runtime/entry.tsx`:
```tsx
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import * as sdk from './sdk'
import { call, connect } from './bridge-client'

type PluginModule = { default?: React.ComponentType }
declare global {
  interface Window {
    ScholeraStudio: typeof sdk & { React: typeof React; jsxRuntime: typeof jsxRuntime }
    __scholeraPlugin?: PluginModule
  }
}

window.ScholeraStudio = { ...sdk, React, jsxRuntime }

class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <sdk.Empty title="This tool stopped working" description="Reload the page. If it keeps happening, the professor can roll back to an earlier version." />
    ) : (
      this.props.children
    )
  }
}

function boot() {
  const Plugin = window.__scholeraPlugin?.default
  const root = document.getElementById('root')!
  createRoot(root).render(
    <Boundary>{Plugin ? <Plugin /> : <sdk.Empty title="This tool couldn’t load" description="Its code is missing or damaged." />}</Boundary>,
  )
  void connect()
  let last = 0
  new ResizeObserver(() => {
    const height = Math.ceil(document.documentElement.scrollHeight)
    if (Math.abs(height - last) > 1) {
      last = height
      void call('ui.resize', { height }).catch(() => {})
    }
  }).observe(document.body)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
```

The plugin `<script>` runs after `runtime.js` and before `DOMContentLoaded`, so `window.__scholeraPlugin` is set by the time `boot` runs.

- [ ] **Step 4: The internal test plugin (never shown to professors)**

It exists only to prove the runtime. It calls every v1 capability and shows what came back, so the browser check in Task 9 can read the results.

`src/lib/studio/fixtures/bridge-check/manifest.json`:
```json
{
  "name": "Bridge check",
  "description": "Internal test plugin. Calls every v1 capability and shows the results.",
  "bridgeVersion": "v1",
  "capabilities": ["context.get", "course.skills", "ui.resize", "ui.toast"]
}
```

`src/lib/studio/fixtures/bridge-check/plugin.tsx`:
```tsx
import { Button, Empty, Heading, Panel, Stack, Text, toast, useCapability, type CourseContext, type CourseSkill } from '@/lib/studio/runtime/sdk'

export default function BridgeCheck() {
  const context = useCapability<CourseContext>('context.get')
  const skills = useCapability<CourseSkill[]>('course.skills')

  if (context.loading || skills.loading) return <Text tone="muted">Loading…</Text>
  if (context.error || skills.error) {
    return <Empty title="A capability failed" description={context.error ?? skills.error ?? ''} />
  }
  return (
    <Stack gap={4}>
      <Heading>Bridge check</Heading>
      <Panel>
        <Stack gap={2}>
          <Text>{`Course: ${context.data?.course.code} ${context.data?.course.title}`}</Text>
          <Text>{`Role: ${context.data?.role}`}</Text>
          <Text>{`Skills: ${skills.data?.length ?? 0}`}</Text>
        </Stack>
      </Panel>
      <Button className="h-11" onClick={() => toast('Bridge check toast', 'success')}>Send a toast</Button>
    </Stack>
  )
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck` and `npx eslint src/lib/studio src/components/studio/kit`
Expected: both clean. `useCapability` must not be flagged by `react-hooks/exhaustive-deps` (the `key` string is the dependency by design).

---

### Task 6: Build step for the runtime and the test plugin

**Files:**
- Create: `scripts/build-studio-runtime.mjs`
- Modify: `package.json` (scripts `predev`, `prebuild`; devDependency `esbuild`), `.gitignore`

- [ ] **Step 1: Pin esbuild as an explicit dev dependency (same version already installed)**

Run: `npm install --save-dev --save-exact esbuild@0.27.3`
Expected: `package.json` gains `"esbuild": "0.27.3"` under devDependencies. Check `git diff package-lock.json` is limited to esbuild's entries.

- [ ] **Step 2: Write the build script**

`scripts/build-studio-runtime.mjs`:
```js
// Builds the Studio plugin runtime and the internal test plugin into public/studio-runtime/v1/.
// Runs before `next dev` and `next build` (predev/prebuild). Output is gitignored.
import { build } from 'esbuild'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'public/studio-runtime/v1')
const src = join(root, 'src')
mkdirSync(join(out, 'fixtures'), { recursive: true })

const alias = { '@': src }
const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias,
  logLevel: 'warning',
}

await build({ ...common, entryPoints: [join(src, 'lib/studio/runtime/entry.tsx')], outfile: join(out, 'runtime.js') })

// Plugins use the runtime's React and SDK instead of bundling their own copies. Athena-built
// plugins will be compiled with this same plugin (studio-globals) in a later step.
const toGlobal = {
  name: 'studio-globals',
  setup(b) {
    const map = {
      react: 'window.ScholeraStudio.React',
      'react/jsx-runtime': 'window.ScholeraStudio.jsxRuntime',
      '@/lib/studio/runtime/sdk': 'window.ScholeraStudio',
    }
    b.onResolve({ filter: /^(react|react\/jsx-runtime|@\/lib\/studio\/runtime\/sdk)$/ }, (a) => ({ path: a.path, namespace: 'studio-global' }))
    b.onLoad({ filter: /.*/, namespace: 'studio-global' }, (a) => ({ contents: `module.exports = ${map[a.path]}`, loader: 'js' }))
  },
}

const fixturesDir = join(src, 'lib/studio/fixtures')
for (const key of readdirSync(fixturesDir).filter((d) => statSync(join(fixturesDir, d)).isDirectory())) {
  await build({
    ...common,
    alias: {},
    plugins: [toGlobal],
    globalName: '__scholeraPlugin',
    entryPoints: [join(fixturesDir, key, 'plugin.tsx')],
    outfile: join(out, 'fixtures', `${key}.js`),
  })
}
console.log('studio runtime built')
```

The runtime build uses `alias` so kit imports like `@/components/ui/button` resolve. Plugin builds must not alias `@`, because the only `@/` import a plugin may make (`@/lib/studio/runtime/sdk`) is intercepted by `studio-globals`. Any other `@/` import from plugin code fails the build, which is intended.

- [ ] **Step 3: Wire it into npm scripts and ignore the output**

In `package.json` `scripts`, add:
```json
"predev": "node scripts/build-studio-runtime.mjs",
"prebuild": "node scripts/build-studio-runtime.mjs",
```
In `.gitignore`, append:
```
# Studio plugin runtime, generated by scripts/build-studio-runtime.mjs
/public/studio-runtime/
```

- [ ] **Step 4: Run it**

Run: `node scripts/build-studio-runtime.mjs && ls -la public/studio-runtime/v1 public/studio-runtime/v1/fixtures`
Expected: `studio runtime built`, `runtime.js` well under 1 MB, and `fixtures/bridge-check.js`, a few KB (it carries no React).

- [ ] **Step 5: Checkpoint.** Stop the running dev server, then restart it with `npm run dev` (it now runs `predev`). Offer a commit: `feat(studio): plugin kit, in-frame runtime and test plugin`.

---

### Task 7: Queries, capability handlers and server actions

**Files:**
- Create: `src/lib/studio/queries.ts`, `src/lib/studio/capability-handlers.ts`, `scripts/dev-setup/studio-install-fixture.mjs`
- Create: `src/app/(dashboard)/professor/courses/[sectionId]/studio/actions.ts`
- Test: `src/__tests__/actions-studio.test.ts`

- [ ] **Step 1: Queries**

`src/lib/studio/queries.ts`:
```ts
// Studio reads. Same conventions as src/lib/supabase/queries.ts (client first, errors
// caught, safe fallbacks). Kept in its own file for the long-lived feature/studio
// branch; fold into queries.ts when it merges.
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export interface InstalledPlugin {
  id: string
  name: string
  current_version: number
  created_at: string
}

export interface PluginForRun {
  id: string
  section_id: string
  institution_id: string
  name: string
  status: 'installed' | 'archived'
  version: { manifest: unknown; code: string; approved_capabilities: string[] }
}

export const studioQueries = {
  async listInstalled(db: SupabaseClient, sectionId: string): Promise<InstalledPlugin[]> {
    try {
      const { data, error } = await db
        .from('studio_plugins')
        .select('id, name, current_version, created_at')
        .eq('section_id', sectionId)
        .eq('status', 'installed')
        .order('created_at', { ascending: false })
      if (error) {
        logger.error('studioQueries.listInstalled', error, { sectionId })
        return []
      }
      return (data ?? []) as InstalledPlugin[]
    } catch (error) {
      logger.error('studioQueries.listInstalled', error, { sectionId })
      return []
    }
  },

  async getForRun(db: SupabaseClient, pluginId: string): Promise<PluginForRun | null> {
    try {
      const { data: plugin, error } = await db
        .from('studio_plugins')
        .select('id, section_id, institution_id, name, status, current_version')
        .eq('id', pluginId)
        .maybeSingle()
      if (error || !plugin) {
        if (error) logger.error('studioQueries.getForRun plugin', error, { pluginId })
        return null
      }
      const { data: version, error: vErr } = await db
        .from('studio_plugin_versions')
        .select('manifest, code, approved_capabilities')
        .eq('plugin_id', pluginId)
        .eq('version', plugin.current_version)
        .maybeSingle()
      if (vErr || !version) {
        if (vErr) logger.error('studioQueries.getForRun version', vErr, { pluginId })
        return null
      }
      return { ...plugin, version } as PluginForRun
    } catch (error) {
      logger.error('studioQueries.getForRun', error, { pluginId })
      return null
    }
  },
}
```

- [ ] **Step 2: Server-only handlers and bundle reader**

`src/lib/studio/capability-handlers.ts`:
```ts
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { skillQueries } from '@/lib/supabase/queries'
import type { CapabilityName } from './capabilities'

export interface HandlerContext {
  db: SupabaseClient
  sectionId: string
  role: 'professor' | 'ta' | 'grader'
}

const resolveJoin = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v)

export const SERVER_HANDLERS: Partial<Record<CapabilityName, (ctx: HandlerContext) => Promise<unknown>>> = {
  async 'context.get'({ db, sectionId, role }) {
    const { data } = await db.from('course_sections').select('course:courses(title, code)').eq('id', sectionId).maybeSingle()
    const course = resolveJoin((data as { course: { title: string; code: string } | { title: string; code: string }[] | null } | null)?.course ?? null)
    return {
      role: role === 'professor' ? 'professor' : 'assistant',
      course: { title: course?.title ?? '', code: course?.code ?? '' },
    }
  },

  async 'course.skills'({ db, sectionId }) {
    const rows = (await skillQueries.listSectionSkills(db, sectionId)).filter((s) => !s.excluded && !s.suppressed)
    const byId = new Map(rows.map((s) => [s.id, s.name]))
    return rows.map((s) => ({ name: s.name, parent: s.parent_id ? byId.get(s.parent_id) ?? null : null }))
  },
}
```

Confirm `server-only` is available: `ls node_modules/server-only`. If it is not installed, drop that import line (do not add a package). Confirm `SkillRow` has `excluded`, `suppressed`, `parent_id`, `name`, `id` (the select in `listSectionSkills` includes all five).

`scripts/dev-setup/studio-install-fixture.mjs` (local only; this is the only way a plugin gets into a course in F1):
```js
// Installs the internal bridge-check plugin into a LOCAL course section, for testing the runtime.
// Usage: node scripts/dev-setup/studio-install-fixture.mjs <sectionId>
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const url = env.NEXT_PUBLIC_SUPABASE_URL
if (!url?.startsWith('http://127.0.0.1') && !url?.startsWith('http://localhost')) {
  console.error(`Refusing: ${url} is not a local database.`)
  process.exit(1)
}
const sectionId = process.argv[2]
if (!sectionId) { console.error('Usage: studio-install-fixture.mjs <sectionId>'); process.exit(1) }

const db = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const code = readFileSync('public/studio-runtime/v1/fixtures/bridge-check.js', 'utf8')
const manifest = JSON.parse(readFileSync('src/lib/studio/fixtures/bridge-check/manifest.json', 'utf8'))
const { data: section, error: sErr } = await db.from('course_sections').select('institution_id, professor_id').eq('id', sectionId).single()
if (sErr) throw sErr

const { data: plugin, error: pErr } = await db.from('studio_plugins')
  .insert({ institution_id: section.institution_id, section_id: sectionId, name: manifest.name, created_by: section.professor_id })
  .select('id').single()
if (pErr) throw pErr
const { error: vErr } = await db.from('studio_plugin_versions').insert({
  plugin_id: plugin.id, institution_id: section.institution_id, version: 1, manifest, code,
  code_sha256: createHash('sha256').update(code).digest('hex'), bridge_version: manifest.bridgeVersion,
  approved_capabilities: manifest.capabilities, approved_by: section.professor_id,
})
if (vErr) throw vErr
console.log(`Installed bridge-check as ${plugin.id}`)
```

In production, plugins are created only through Athena's builder, with the professor approving the plugin card (rule 8.2). That comes in a later step, so F1 has no install action.

- [ ] **Step 3: Write the failing action tests**

`src/__tests__/actions-studio.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAccess = vi.fn()
const mockGetForRun = vi.fn()

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/auth/section-access', () => ({ verifySectionAccess: (...a: unknown[]) => mockAccess(...a) }))
vi.mock('@/lib/studio/queries', () => ({ studioQueries: { getForRun: (...a: unknown[]) => mockGetForRun(...a) } }))
vi.mock('@/lib/supabase/queries', () => ({
  skillQueries: {
    listSectionSkills: vi.fn(async () => [
      { id: 's1', name: 'Loops', parent_id: null, excluded: false, suppressed: false },
      { id: 's2', name: 'For loops', parent_id: 's1', excluded: false, suppressed: false },
      { id: 's3', name: 'Hidden', parent_id: null, excluded: true, suppressed: false },
    ]),
  },
}))

function adminDb() {
  return {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { institution_id: 'inst-1' }, error: null }) }) }),
      update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    }),
  }
}

const RUN = {
  id: '11111111-1111-4111-8111-111111111111', section_id: 'sec-1', institution_id: 'inst-1', name: 'Bridge check', status: 'installed',
  version: { manifest: { name: 'x', description: 'x', bridgeVersion: 'v1', capabilities: ['course.skills', 'ui.resize'] }, code: '', approved_capabilities: ['course.skills', 'ui.resize'] },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let actions: any
beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } } })
  mockAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: adminDb() })
  mockGetForRun.mockResolvedValue(RUN)
  actions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions')
})

describe('callPluginCapability', () => {
  it('returns the section’s visible skills with parent names', async () => {
    const r = await actions.callPluginCapability(RUN.id, 'course.skills', {})
    expect(r).toEqual({ data: [{ name: 'Loops', parent: null }, { name: 'For loops', parent: 'Loops' }] })
  })
  it('refuses a caller without section access (checked against the PLUGIN’s section)', async () => {
    mockAccess.mockResolvedValue({ ok: false, adminDb: adminDb() })
    expect(await actions.callPluginCapability(RUN.id, 'course.skills', {})).toHaveProperty('error')
    expect(mockAccess).toHaveBeenCalledWith('sec-1', 'prof-1')
  })
  it('refuses a capability the manifest lists but the professor did not approve', async () => {
    mockGetForRun.mockResolvedValue({ ...RUN, version: { ...RUN.version, approved_capabilities: ['ui.resize'] } })
    expect(await actions.callPluginCapability(RUN.id, 'course.skills', {})).toHaveProperty('error')
  })
  it('refuses a capability outside the manifest', async () => {
    expect(await actions.callPluginCapability(RUN.id, 'context.get', {})).toHaveProperty('error')
  })
  it('refuses arguments that carry an identifier (rule 2.1)', async () => {
    expect(await actions.callPluginCapability(RUN.id, 'course.skills', { sectionId: 'other' })).toHaveProperty('error')
  })
  it('refuses an archived plugin and a host-only capability', async () => {
    mockGetForRun.mockResolvedValue({ ...RUN, status: 'archived' })
    expect(await actions.callPluginCapability(RUN.id, 'course.skills', {})).toHaveProperty('error')
    mockGetForRun.mockResolvedValue(RUN)
    expect(await actions.callPluginCapability(RUN.id, 'ui.resize', { height: 10 })).toHaveProperty('error')
  })
  it('refuses a signed-out caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    expect(await actions.callPluginCapability(RUN.id, 'course.skills', {})).toHaveProperty('error')
  })
})

describe('archivePlugin', () => {
  it('refuses a TA or grader (rule 8.1)', async () => {
    mockAccess.mockResolvedValue({ ok: true, role: 'ta', adminDb: adminDb() })
    expect(await actions.archivePlugin('22222222-2222-4222-8222-222222222222', RUN.id)).toHaveProperty('error')
  })
  it('archives for the professor', async () => {
    expect(await actions.archivePlugin('22222222-2222-4222-8222-222222222222', RUN.id)).toEqual({ success: true })
  })
})
```

- [ ] **Step 4: Run and confirm failure**

Run: `npx vitest run src/__tests__/actions-studio.test.ts` — Expected: FAIL, actions module missing.

- [ ] **Step 5: Implement the actions**

`src/app/(dashboard)/professor/courses/[sectionId]/studio/actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { isCapabilityName, isServerCapability, parseCapabilityArgs } from '@/lib/studio/capabilities'
import { SERVER_HANDLERS } from '@/lib/studio/capability-handlers'
import { parseManifest } from '@/lib/studio/manifest'
import { studioQueries } from '@/lib/studio/queries'

const uuid = z.string().uuid()
const DENIED = { error: 'This tool isn’t available.' }

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

export async function archivePlugin(sectionId: string, pluginId: string) {
  const userId = await currentUserId()
  if (!userId || !uuid.safeParse(sectionId).success || !uuid.safeParse(pluginId).success) return DENIED

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || access.role !== 'professor') return { error: 'Only the course’s professor can remove tools.' }

  const { error } = await access.adminDb
    .from('studio_plugins')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('id', pluginId)
    .eq('section_id', sectionId)
  if (error) {
    logger.error('StudioActions.archivePlugin', error, { pluginId })
    return { error: 'Couldn’t remove this tool right now. Try again in a moment.' }
  }
  void logEvent({ userId, eventType: 'studio_plugin_archived', eventCategory: 'studio', sectionId, metadata: { pluginId } })
  revalidatePath(`/professor/courses/${sectionId}/studio`)
  return { success: true as const }
}

/** The only door from a plugin to the server. Assumes every call is hostile (rule 2.2). */
export async function callPluginCapability(pluginId: string, capability: string, args: unknown) {
  const userId = await currentUserId()
  if (!userId || !uuid.safeParse(pluginId).success || !isCapabilityName(capability) || !isServerCapability(capability)) return DENIED

  const parsedArgs = parseCapabilityArgs(capability, args)
  if (!parsedArgs.ok) return DENIED

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = await studioQueries.getForRun(createAdminClient() as any, pluginId)
  if (!plugin || plugin.status !== 'installed') return DENIED

  const access = await verifySectionAccess(plugin.section_id, userId)
  if (!access.ok) return DENIED

  const manifest = parseManifest(plugin.version.manifest)
  if (!manifest.ok || !manifest.manifest.capabilities.includes(capability) || !plugin.version.approved_capabilities.includes(capability)) {
    return DENIED
  }

  const handler = SERVER_HANDLERS[capability]
  if (!handler) return DENIED
  try {
    return { data: await handler({ db: access.adminDb, sectionId: plugin.section_id, role: access.role }) }
  } catch (error) {
    logger.error('StudioActions.callPluginCapability', error, { pluginId, capability })
    return { error: 'Something went wrong. Try again.' }
  }
}
```

- [ ] **Step 6: Run the tests until they pass**

Run: `npx vitest run src/__tests__/actions-studio.test.ts`
Expected: PASS (9 tests). Adjust the `adminDb()` stub if the chained calls differ, never the assertions.

- [ ] **Step 7: Checkpoint.** Lint, typecheck, offer a commit: `feat(studio): archive and the checked plugin bridge action`.

---

### Task 8: The host and the Studio UI

**Files:**
- Create: `src/components/studio/host/PluginHost.tsx`, `src/components/studio/InstalledPlugins.tsx`
- Create: `src/app/(dashboard)/professor/courses/[sectionId]/studio/[pluginId]/page.tsx`
- Modify: `src/app/(dashboard)/professor/courses/[sectionId]/studio/page.tsx`

- [ ] **Step 1: PluginHost (client)**

```tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { buildSrcdoc } from '@/lib/studio/srcdoc'
import { parseFrameMessage, type HostMessage } from '@/lib/studio/protocol'
import { createBucket } from '@/lib/studio/rate-limit'
import { isServerCapability, parseCapabilityArgs } from '@/lib/studio/capabilities'
import { STUDIO_BRIDGE_CALLS_PER_MINUTE } from '@/lib/studio/limits'
import { callPluginCapability } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/actions'

export function PluginHost({ pluginId, name, code, approved }: { pluginId: string; name: string; code: string; approved: string[] }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(480)
  const [srcdoc, setSrcdoc] = useState<string | null>(null)
  const bucket = useMemo(() => createBucket(STUDIO_BRIDGE_CALLS_PER_MINUTE), [])

  useEffect(() => {
    const stylesheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((l) => l.href)
    const nonce = crypto.randomUUID().replace(/-/g, '')
    setSrcdoc(buildSrcdoc({ origin: location.origin, nonce, stylesheets, bodyClass: document.body.className, pluginCode: code }))
  }, [code])

  useEffect(() => {
    const reply = (msg: HostMessage) => frame.current?.contentWindow?.postMessage(msg, '*')
    const onMessage = async (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const msg = parseFrameMessage(event.data)
      if (!msg) return
      if (msg.kind === 'ready') return reply({ type: 'studio:init', bridgeVersion: 'v1' })
      const fail = (error: string) => reply({ type: 'studio:result', id: msg.id, ok: false, error })
      if (!approved.includes(msg.capability)) return fail('This tool isn’t allowed to do that.')
      if (!bucket.take()) return fail('Too many requests. Slow down and try again.')
      if (msg.capability === 'ui.resize') {
        const p = parseCapabilityArgs('ui.resize', msg.args)
        if (!p.ok) return fail('Invalid request.')
        setHeight(Math.min(Math.max(p.args.height, 120), 4000))
        return reply({ type: 'studio:result', id: msg.id, ok: true, data: null })
      }
      if (msg.capability === 'ui.toast') {
        const p = parseCapabilityArgs('ui.toast', msg.args)
        if (!p.ok) return fail('Invalid request.')
        const show = p.args.tone === 'error' ? toast.error : p.args.tone === 'success' ? toast.success : toast
        show(p.args.message)
        return reply({ type: 'studio:result', id: msg.id, ok: true, data: null })
      }
      if (!isServerCapability(msg.capability)) return fail('Invalid request.')
      const result = await callPluginCapability(pluginId, msg.capability, msg.args)
      if ('data' in result) reply({ type: 'studio:result', id: msg.id, ok: true, data: result.data })
      else fail(result.error ?? 'Something went wrong.')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [approved, bucket, pluginId])

  if (!srcdoc) return <div className="h-96 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" aria-hidden="true" />
  return (
    <iframe
      ref={frame}
      title={name}
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      style={{ height }}
      className="w-full rounded-2xl border-0 bg-background shadow-sm"
    />
  )
}
```

Check `toast`'s import path in the app (`grep -rn "from 'sonner'" src/components | head -3`) and match it.

- [ ] **Step 2: Plugin page**

`src/app/(dashboard)/professor/courses/[sectionId]/studio/[pluginId]/page.tsx`: server component. Get the user (notFound if none) and run `verifySectionAccess(sectionId, user.id)` (notFound if not ok). Load `studioQueries.getForRun(access.adminDb, pluginId)`. Call `notFound()` if it's missing, if `plugin.section_id !== sectionId`, or if the status isn't `installed`. Render a heading with the plugin name, a back link to `…/studio`, and `<PluginHost pluginId name code approved>`.

- [ ] **Step 3: The installed list**

- `InstalledPlugins` (server-safe): takes `sectionId`, `plugins: InstalledPlugin[]` and `canManage: boolean`. It renders cards linking to `…/studio/{id}`. When `canManage`, it adds a **Remove** button in a small client child. The child calls `archivePlugin`, shows `toast.success`/`toast.error`, and runs `router.refresh()`. With no plugins, it renders `EmptyState` titled "No tools in this course yet".
- [ ] **Step 4: Compose the Studio page**

In `…/studio/page.tsx`, after the access check, load `studioQueries.listInstalled(access.adminDb, sectionId)`. Professors then see `InstalledPlugins` (manage, headed "In this course") above the existing `StudioWorkspace` builder shell. Course assistants see `InstalledPlugins` (no manage). When the list is empty, they see `StudioLanding` instead.

- [ ] **Step 5: Lint, typecheck, unit tests**

Run: `npx eslint src/components/studio "src/app/(dashboard)/professor/courses/[sectionId]/studio" && npm run typecheck && npx vitest run src/__tests__/studio-*.test.ts src/__tests__/actions-studio.test.ts`
Expected: clean and all passing.

---

### Task 9: Browser verification, including the security probes

**Files:** a scratchpad Playwright script (not committed).

- [ ] **Step 1: Happy path.** Run `node scripts/build-studio-runtime.mjs`, then `node scripts/dev-setup/studio-install-fixture.mjs bec3377d-1a20-5b5d-8fd0-58095a4438bc` (local CS101). Log in as `professor@scholera.dev` and open CS101, then Studio, then "Bridge check". Check the frame shows the course code and title, "Role: professor", a skill count matching the section, and Scholera's fonts and components. "Send a toast" shows a Scholera toast. Take a screenshot.

- [ ] **Step 2: Fonts.** In the frame, evaluate `document.fonts.check('16px "Geist"')`, or compare the computed `font-family` rendering with the host's. If the frame falls back to a default font, add to `next.config.ts` `headers()`:
```ts
{
  source: '/_next/static/media/:path*',
  headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
},
```
Font files are public static assets, so allowing any origin to fetch them exposes nothing. Restart dev and re-check.

- [ ] **Step 3: Security probes.** Inject each probe into a test-only plugin code string passed to `buildSrcdoc`, or use `frame.evaluate` against the plugin frame. Each must fail. Besides the probes below, add one per requirement in the rules doc appendix that has none yet: the frame navigating itself (N9, the host must remove the frame), `new RTCPeerConnection` (N10), `<link rel="dns-prefetch">` (N11), and a stylesheet load that checks no session cookie is sent (N6).
  - `fetch('/api/chat')`: blocked by the content security policy (`connect-src 'none'`).
  - `document.cookie`: throws a `SecurityError` in an opaque-origin frame, or returns `''`.
  - `window.top.location.href = '/'`: throws, because there's no top-navigation permission.
  - `window.parent.postMessage({ type: 'studio:call', id: 'x', capability: 'course.skills', args: { sectionId: '<another section>' } }, '*')`: the result is `ok: false`.
  - A plugin whose code contains `</script><script>alert(1)</script>`: no alert, and the plugin still boots.

- [ ] **Step 4: Roles.** As `ta@scholera.dev` (the local TA), confirm the installed tools are listed and open, with no Install or Remove buttons. As `student1@scholera.dev`, confirm the plugin URL shows the no-access page.

- [ ] **Step 5: Checkpoint.** Run the full Studio test set and `npm run test:db`, then offer a commit: `feat(studio): run installed plugins in the sandboxed host`.

---

### Task 10: Documentation

- [ ] Update the Studio bullet in `docs/onboarding/guide/3-concepts.md` (keep it at the end of its section). Say that plugins are installed per section and stored as frozen versions in `studio_plugins` / `studio_plugin_versions`, and that they run in a sandboxed frame. Also say the tables are server-only, and point to `docs/reference/studio-plugin-rules.md`.
- [ ] Set the status in `docs/designs/studio/studio-runtime.md` to `Built (F1)`, and record the two changes from the design. First, client access to the new tables is none rather than a read policy, because graders would be excluded. Second, dark-mode mirroring was dropped because the app has no dark mode.
- [ ] Final gate before any commit: scoped lint, full typecheck, unit tests, `npm run test:db`, and the review agents (UX, test, security), as CLAUDE.md requires.
