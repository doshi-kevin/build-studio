/**
 * A plugin version's artifact: exactly what the validator judges and what runs. Its
 * sha256 binds a verdict to that content: a verdict counts only for the artifact it was
 * reached on (docs/reference/studio-plugin-validator.md, "Artifact").
 *
 * The bundles hold only plugin-authored code. React and the plugin kit are Scholera's,
 * in the runtime's pinned vendor.js, so they are not part of any plugin's artifact.
 */
import { createHash } from 'node:crypto'

/** Bumped only if what goes into the hash changes. Part of the hash itself. */
export const ARTIFACT_FORMAT = 'studio-artifact-v1'

export interface PluginArtifact {
  manifest: unknown
  /** Source files by path, as stored with the version. */
  source: Record<string, unknown>
  studentBundle: string
  professorBundle: string
}

/** JSON with object keys sorted at every level, so equal content always hashes equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

export function artifactHash(artifact: PluginArtifact): string {
  const canonical = canonicalJson({
    format: ARTIFACT_FORMAT,
    manifest: artifact.manifest,
    source: artifact.source,
    bundles: { student: artifact.studentBundle, professor: artifact.professorBundle },
  })
  return createHash('sha256').update(canonical).digest('hex')
}
