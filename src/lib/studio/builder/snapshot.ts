/**
 * Draft identity. A snapshot's hash covers exactly what reproduces the draft: the stamped
 * manifest, the two view sources and the compiler that turns them into bundles. Keys are
 * sorted at every level (canonicalJson), so key order never changes a hash, and nothing
 * mutable (timestamps, run ids, check results) is part of it.
 *
 * Content is hashed as given. Validation refuses bad input before this point and never
 * rewrites it, so "\r\n" and "\n" are different drafts.
 */
import { createHash } from 'node:crypto'
import { canonicalJson } from '../validator/artifact'
import type { PluginPath } from './paths'

export const SNAPSHOT_FORMAT = 'studio-draft-v1'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function snapshotHash(compiler: string, manifest: unknown, files: Record<PluginPath, string>): string {
  return sha256(canonicalJson({ format: SNAPSHOT_FORMAT, compiler, manifest, files }))
}

/** The check cache key for a working copy: a cached result never applies to edited code. */
export function workHash(manifest: unknown, files: Partial<Record<PluginPath, string>>): string {
  return sha256(canonicalJson({ format: 'studio-work-v1', manifest: manifest ?? null, files }))
}

export const contentHash = (value: unknown) => sha256(canonicalJson(value))

/** The first 16 hex characters: enough to tell writes apart in a trajectory. */
export const sha16 = (text: string) => sha256(text).slice(0, 16)
