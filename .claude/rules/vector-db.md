---
paths:
  - "src/lib/pinecone/**"
  - "src/lib/embeddings/**"
  - "eval/retrieval/**"
---

# Vector Database Rules — Pinecone

Pinecone is the team's vector store. It has **no RLS, no per-user auth, no namespace-scoped keys** — application code IS the tenant boundary, so these rules are security rules, same severity as `.claude/rules/security-server-actions.md`.

## Decision guide — the default is always "reuse the existing thing"

Every vector feature faces the same recurring decisions. Each has a default; **deviating from any default requires a one-paragraph justification in the PR / design doc** (see the vector-surface item in `docs/reference/system-design-rules.md`).

| Decision | Default | Deviate only when |
|---|---|---|
| Vector store | Pinecone, existing project | Never per-feature. Adding any other vector store (incl. pgvector) is an architecture change requiring team sign-off. |
| Index | The existing workload index | The use case needs a **different embedding model, metric, or dimension**, or a genuinely different workload shape. A new index = editing the checked-in setup script — never created in feature code. |
| Namespace | Derived `(institution, course)` — never hand-picked; created implicitly on first upsert through the wrapper | Never per-feature. Changing namespace granularity is an ADR-level decision. |
| Scoping a use case | Existing namespaces + a metadata filter | — (this is the answer for "new feature, same content"). |
| Embedding model | The one pinned config constant | Model change = blue/green re-index in its own PR, gated on the golden eval. |
| Chunking | The versioned `CHUNKING_CONFIG` constant | Only with a green golden-eval delta showing the change helps. |
| Content class | Existing allowlisted classes (professor/institution-authored material) | New class — especially anything student-generated — needs recorded policy sign-off and an erasure-path extension in the same PR. |
| Retrieval knobs (topK, rerank, threshold) | An existing named retrieval profile | New profile, with before/after eval numbers in the PR. |
| Freshness | Async — content shows a "processing" state until indexed | Synchronous visibility only with a written product need (eventual consistency makes "instant" a lie anyway). |

## Tenancy & access (the leak-prevention core)

1. **All Pinecone access goes through the one server-only wrapper module (`src/lib/pinecone/`).** `import 'server-only'` at top; raw `@pinecone-database/pinecone` imports anywhere else fail review. The wrapper never exposes the raw `Index` object — it returns namespace-bound clients only.
2. **Every data-plane function takes a required `institutionId` (+ `courseId`) and derives the namespace internally** via the single `namespaceFor()` helper (`inst_{institution_id}__course_{course_id}`). No public API accepts a namespace string. An omitted namespace silently targets the shared default namespace — the most dangerous default in Pinecone.
3. **Tenant scope comes from the authenticated session (`getAuthUser()` → profile), never from client input — including background jobs** (jobs receive `institutionId` as an explicit required param). Client-supplied namespace = IDOR at the vector layer. Never rely on the LLM/prompt layer for access control.
4. **The default namespace (`""`/`__default__`) stays permanently empty** — a non-empty default namespace means some code path dropped tenant scope (monitored by canary).
5. **Every vector op runs the standard sequence**: `getAuthUser() → verifyOwnership/Enrollment → op → logEvent()`. Pinecone's own audit logs can't tell us who queried which tenant — our `logEvent()` trail is the only detective control.
6. **`PINECONE_API_KEY` is server-only** — never `NEXT_PUBLIC_*`, never in a `'use client'` tree, never logged. Same sensitivity as `SUPABASE_SERVICE_ROLE_KEY` (one key reads every institution's vectors).
7. **There is only ONE index, and every environment names it with the same variable** — so `npm run dev` on a laptop writes into the production namespaces. (An earlier version of this rule claimed dev and prod use separate Pinecone projects. They do not, and believing it is how 717 orphan vectors reached production in August 2026.) Writes are therefore gated: `assertVectorWritesAllowed()` in `src/lib/pinecone/client.ts` throws on any write outside `NODE_ENV=production` unless you set **`PINECONE_ALLOW_NONPROD_WRITES=true`** for that one shell. Reads are ungated so local search still works. If you add a function that upserts or deletes, call the guard first — `src/__tests__/pinecone-nonprod-write-guard.test.ts` derives the write list from the source and will fail until you do.

## Data modeling

7. **Vector IDs are deterministic**: `{material_id}#c{zero-padded chunk_index}`, built only by the shared `buildChunkId()` helper. Deterministic IDs make ingestion idempotent and prefix-list+delete possible; user-derived vectors (if ever enabled) carry `u_{user_id}` in the prefix for erasure. **The Postgres↔Pinecone link is this derivation — never store a `pinecone_id` column in Postgres.** Pinecone doesn't generate IDs (we mint them from the source row's PK), so a stored copy is derivable state that drifts; Postgres stores sync state instead (`embedding_status`, model/version, `content_hash`), and cross-store integrity is enforced by the reconciliation sweep, not a constraint.
8. **Metadata is a zod-`.strict()` whitelist**: opaque UUIDs/enums, locators, provenance stamps (`embedding_model`, `embedding_version`, `chunker_version`). No PII, no student names/emails/grades, no chunk text (hydrate from Postgres by ID so RLS is the last line of defense), ≤40 KB, flat scalars only, timestamps as numeric epoch, IDs as strings.
9. **One embedding model + version + dimension per index, pinned in one config constant.** Document and query embedding go through the same `embedText()` helper. Model change = blue/green new index, never in-place re-embedding (a mixed-model index corrupts retrieval with zero errors).
10. **Postgres is the source of truth** — every vector reconstructable from the RLS-protected `document_chunks` table. Document update = **delete-then-upsert** (plain upsert of a shorter v2 strands stale tail chunks). Sync via async outbox worker (never embed inline in the request path) + scheduled reconciliation sweep. Delete paths ship in the same PR as write paths.

## Queries & resilience

11. **Every query**: explicit namespace, scoping in the metadata `filter` (never fetch-then-filter), `includeValues: false`, client-side timeout (`AbortSignal` — the TS SDK has none built in), circuit-breaker-wrapped, declared degraded fallback, and tenant-stamp asserted on results (throw on mismatch — loud error beats silent leak). Serverless is eventually consistent: never write-then-immediately-query.
12. **RAG paths**: `top_k` 25–100 → rerank → `top_n` 3–10, from a named retrieval profile (no inline literals); post-rerank score floor as a named constant with an explicit "insufficient context" branch; citations in every answer. No retrieval-knob change merges without a green golden-eval run (`eval/retrieval/`) vs the committed baseline — against the eval index, never live tenant namespaces.

## Index lifecycle (immutables)

- `metric`, `dimension`, `cloud/region`, `vector_type` are **immutable at creation**. Indexes are created only via the checked-in setup script — serverless (`ServerlessSpec`) only, `gcp`/`us-central1`, `deletion_protection` on prod. `PodSpec` and console-created indexes are banned.
- Index names/hosts come from env vars, never hardcoded (the env var is the blue/green alias).
- Tests: unit tests hit an in-memory fake of the wrapper; integration tests hit Pinecone Local (Docker) — never prod. The wrapper asserts at boot that test/CI runs point at localhost.
