/**
 * Who may do what to plugin records. Pure: no database, no session. The record
 * service resolves the role and the installation state from trusted data, then asks
 * this function. The table it encodes is in docs/reference/studio-plugin-server.md.
 */
import type { SectionRole } from '@/lib/auth/section-access'

export type ViewerRole = SectionRole | 'student'
export type CollectionAccess = 'perStudent' | 'shared' | 'staffOnly'
export type RecordOperation = 'list' | 'get' | 'create' | 'update' | 'delete'
export type InstallationState = 'active' | 'archived'

export type Decision =
  | { allow: false }
  | {
      allow: true
      /** 'self': every query is filtered to records the viewer owns. */
      ownerFilter: 'self' | 'none'
      /** 'self': a created record is owned by the viewer. */
      ownerStamp: 'self' | 'none'
    }

const DENY: Decision = { allow: false }
const READ_ALL: Decision = { allow: true, ownerFilter: 'none', ownerStamp: 'none' }
const OWN: Decision = { allow: true, ownerFilter: 'self', ownerStamp: 'self' }

const isRead = (op: RecordOperation) => op === 'list' || op === 'get'

// Authoring writes follow canWriteAsStaff: professor and TA. Graders grade, and
// plugin grading belongs to a later slice, so they are read-only here.
const writesAsStaff = (role: ViewerRole) => role === 'professor' || role === 'ta'

export function decide(
  role: ViewerRole,
  access: CollectionAccess,
  operation: RecordOperation,
  state: InstallationState,
): Decision {
  // An archived installation keeps its history readable and accepts no new work (rule 3.6).
  if (state === 'archived' && !isRead(operation)) return DENY

  if (role === 'student') {
    if (access === 'perStudent') return OWN
    if (access === 'shared') return isRead(operation) ? READ_ALL : DENY
    return DENY // staffOnly never reaches a student (rule 5.2)
  }

  // Staff read the whole section (rule 2.3).
  if (isRead(operation)) return READ_ALL
  // A perStudent record is the student's own work. Staff don't write it in v1.
  if (access === 'perStudent') return DENY
  return writesAsStaff(role) ? READ_ALL : DENY
}
