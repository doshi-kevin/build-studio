// Shared constants: test-user emails, password, auth-state paths.
// Fixture UUIDs live in seed-ids.json (written by scripts/seed-e2e.ts).

import * as path from 'path'

export const SHARED_PASSWORD = 'e2e-password-123'

export const AUTH_STATE_DIR = path.resolve(__dirname, '..', '.auth')

export const TEST_USERS = {
  admin: {
    email: 'e2e-admin@scholera.test',
    role: 'institution_admin',
  },
  professor: {
    email: 'e2e-professor@scholera.test',
    role: 'professor',
  },
  studentEnrolled: {
    email: 'e2e-student-enrolled@scholera.test',
    role: 'student',
  },
  studentNew: {
    email: 'e2e-student-new@scholera.test',
    role: 'student',
  },
} as const

export type TestUserRole = keyof typeof TEST_USERS

export function storageStatePath(role: TestUserRole): string {
  return path.join(AUTH_STATE_DIR, `${role}.json`)
}
