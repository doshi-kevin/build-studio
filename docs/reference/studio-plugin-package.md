# Studio Plugin Packages and the Plugin Server Runtime

What a Studio plugin is since 2026-10-17, and how its own server code runs.

| | |
|---|---|
| **Status** | Built and tested locally. Server code runs only on a developer machine until the container executor exists (see [Production](#production)) |
| **Owner** | Kevin Dohsi |
| **Migration** | `supabase/migrations/20261017180000_studio_plugin_package.sql` |
| **Tests** | `src/__tests__/studio-plugin-package.test.ts`, the package follow-up case in `studio-builder-harness.test.ts` |

## What a plugin is

A plugin is source code: a package of TypeScript files, its manifest, and optional sample data. Studio stores every file, versions it, checks it, runs it and edits it on the next request.

| Folder | What goes there | May import |
|---|---|---|
| `views/` | `views/student.tsx` and `views/professor.tsx` (the two entries the frame mounts), plus components and helpers | `views/`, `shared/`, `react`, `@scholera/plugin-kit` |
| `shared/` | Plain TypeScript both sides use: types, formatting, rules that must agree | `shared/` only |
| `server/` | The plugin's server code. `server/index.ts` exports `actions` | `server/`, `shared/`, types from `@scholera/plugin-server` |

A view never imports server code. It calls a server action through the Bridge (`request("server.call", { action, args })`). The compiler and the validator's `source.imports` check both refuse an import across the boundary.

Limits (`src/lib/studio/limits.ts`): 24 files, 32 KiB per file, 192 KiB in all, 80-character paths. A path is one optional sub-folder deep, letters, digits and hyphens, `.ts` or `.tsx` (`.tsx` only under `views/`). The database guard on snapshots enforces the same rule.

Product Intelligence and the product specification are build metadata: they tell the builder what to build and are kept on the run. The product is the package and the versions saved from it.

## Source, snapshots and versions

- **Snapshots** (`studio_plugin_snapshots`) hold every file of a draft in `files`, plus three compiled bundles: student, professor and, when there is server code, `server_bundle`. The snapshot hash covers the compiler id, the manifest, every file and the sample data. The formula didn't change, so old drafts keep their hashes.
- **Versions** (`studio_plugin_versions`) store `source` (every file plus `plugin.manifest.json`) and the three bundles. Save recompiles everything from the snapshot's files. The artifact hash the validator binds to includes the server bundle only when there is one, so earlier versions keep theirs.
- **Old plugins.** A view with no local imports compiles to the same bytes as before, under the same `COMPILER_ID`. Two-file drafts and versions run and save unchanged.

## How server code runs

```
frame: request('server.call', { action, args })
  -> host page -> POST /api/studio/bridge (origin, session, rate limit, stale version)
  -> dispatch: server.call allowed for this view (manifest.server)
  -> executeServerAction (server-runtime/execute.ts)
       action declared for the caller's view, arguments match the manifest, executor exists
  -> PluginExecutor.execute(bundle, action, args, caller)
       every ctx.records / ctx.course call comes back as a capability call
  -> liveCapabilities: records.ts serverRecords under policy.decideForServer
```

The manifest declares the contract in `server.actions`: for each action, `roles` (student, professor), `args` (`text`, `number`, `boolean`, `json`, with `?` for optional) and `reads` (staffOnly collections the action reads when a student calls it). A collection with `writes: "server"` can't be written by any frame, only by server actions. New actions, new roles, new reads and a change to `writes` need the professor's approval, and the plugin card lists every action.

An action runs as the person who called it:

| Caller | Reads | Writes |
|---|---|---|
| Student | shared collections, their own perStudent and staffPerStudent records, staffOnly collections the action lists in `reads` | their own perStudent records, including `writes: "server"` ones |
| Staff | what the professor view reads | what the professor view writes, including `writes: "server"` collections |

A student's call never sees another student's records, and no action can name an installation, user or section: capability parameters are strict and the installation comes from the resolved viewer.

What plugin code gets (`ctx`, typed in `server-runtime/plugin-server-types.ts`): `user.role`, `user.handle` (the student's per-installation handle, null for staff), `records.list/listAll/get/create/update/remove`, `course.get()`, `log.event()`, `random(seed)` (a deterministic generator) and `now()`. Nothing else.

## Security model

The local executor (`server-runtime/local-executor.ts`) runs each call in a fresh `node` child:

- an environment of `NODE_ENV` only, so no key, secret or database URL exists in it;
- Node's permission model, so no file reads or writes, child processes, worker threads or native addons;
- a 96 MB heap cap and a 10 second wall-clock kill;
- plugin code in a `vm` context holding only ECMAScript built-ins, with string code generation and WebAssembly off. No host object crosses into it: replies arrive as JSON text parsed inside the context.

The parent treats the child's output as untrusted: line and result size caps (256 KiB result), at most 64 capability calls and 5 log events per call. A plugin's thrown message goes back to its own frame only and is never logged. Every call is audited (`studio.server.action`) with identifiers, outcome and time.

Trust difference: Node 24's permission model doesn't restrict the network. Code that escaped the `vm` context could open a socket from the child. There is no seccomp, namespace or egress rule on a developer machine. That is why `executorMode` (`server-runtime/executor.ts`) turns the local executor on only when `STUDIO_PLUGIN_EXECUTOR=local` is set and the database is on loopback, whatever `NODE_ENV` says. A dev server pointed at a hosted project, or a deployment that reaches its database through a localhost proxy, never runs plugin code by default.

## Production

A deployed server has no executor, so `server.call` answers "This tool's server isn't available right now" and nothing runs. The container executor is the missing piece: a Cloud Run service per call (gVisor sandbox, no service account, egress denied) that runs `SANDBOX_SOURCE` and speaks the same contract (`server-runtime/contract.ts`) over HTTP, with capability calls answered by a per-call token scoped to the installation and caller. No plugin changes when it lands.

## Preview

A draft's server actions run in the builder's preview and in the design review's screenshots on the preview's synthetic records (`server-runtime/preview.ts`). The page sends its in-memory records with each call and takes back what the action wrote. The professor's preview goes through `draftServerCallAction` (owner only, rate-limited); the renderer forwards calls from `render.mjs` to `renderer.ts` over stdout and stdin lines. Not covered yet: previewing another published version's server actions, and the Stage 2 validator runner, which refuses `server.call`.

## AI as a future capability

Plugin code never holds a model key. An `ai.*` capability would be one more method in `CAPABILITY_METHODS`, answered by trusted code that applies the AI kill switch, the institution's budget and the privacy rules before calling Anthropic, and declared in the manifest so the professor approves it.
