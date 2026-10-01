// The namespace IS the tenant wall — Pinecone has no RLS, so this derivation
// is a security boundary. No public API in this wrapper accepts a namespace
// string; everything derives it here from ids the caller verified.
//
// Granularity is per (institution, SECTION) — a recorded deviation from the
// vector-db rule's per-course default (design doc §9): materials and
// enrollment both live at the section level in Scholera.

// Lenient uuid shape (hex-and-hyphen only — see metadata.ts on why not RFC-strict).
// This is a delimiter-injection guard: a component that could contain "__sec_"
// would let two different (institution, section) pairs collide into one
// namespace string. UUIDs can't contain "_", so enforcing the shape makes the
// derivation unambiguous.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function namespaceFor(institutionId: string, sectionId: string): string {
  if (!UUID_SHAPE.test(institutionId) || !UUID_SHAPE.test(sectionId)) {
    throw new Error('namespaceFor: institutionId and sectionId must be uuids')
  }
  return `inst_${institutionId}__sec_${sectionId}`
}
