/**
 * Student handles: how a staff view of a plugin refers to a student without ever holding
 * a user ID or a name (rule 2.5).
 *
 *   handle = 'st_' + base32hex(HMAC-SHA256(installation salt, student ID))[:20]
 *
 * The salt is per installation and never leaves the server, so a handle is stable for the
 * installation's lifetime, means nothing outside it, and can't be computed or reversed by
 * a plugin. 20 characters are 100 bits: guessing a classmate's handle is out of reach,
 * and a guess is resolved only against the installation's own section anyway.
 *
 * A handle is resolved by recomputing it over the section's roster and comparing, never
 * by a lookup a caller can steer. Names are read here only for the professor's own page
 * (rosterNamesAction); nothing in this module returns a name toward a frame.
 */
import 'server-only'
import { createHmac } from 'node:crypto'
import { STUDENT_HANDLE } from './bridge/catalog'
import * as db from './db'

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv'
const HANDLE_CHARS = 20

/** Pure: the same salt and student always give the same handle. */
export function studentHandle(salt: string, studentId: string): string {
  const mac = createHmac('sha256', salt).update(studentId).digest()
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of mac) {
    buffer = ((buffer << 8) | byte) & 0xfff
    bits += 8
    while (bits >= 5 && out.length < HANDLE_CHARS) {
      out += BASE32HEX[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    if (out.length === HANDLE_CHARS) break
  }
  return `st_${out}`
}

export const isStudentHandle = (value: string) => STUDENT_HANDLE.test(value)

/** One installation's handle function. The salt stays inside it. */
export interface HandleKey {
  of(studentId: string): string
}

/** Null if the installation's salt can't be read: callers fail closed. */
export async function loadHandleKey(installationId: string): Promise<HandleKey | null> {
  const salt = await db.loadInstallationHandleSalt(installationId)
  if (!salt) return null
  return { of: (studentId) => studentHandle(salt, studentId) }
}

export interface HandleRosterEntry {
  handle: string
  student: db.RosterStudent
}

/** The section's eligible students with their handles, sorted by handle so the order
 * carries nothing about names or enrollment. Null when the roster can't be read. */
export async function loadHandleRoster(key: HandleKey, sectionId: string): Promise<HandleRosterEntry[] | null> {
  const roster = await db.loadSectionRoster(sectionId)
  if (!roster) return null
  return roster
    .map((student) => ({ handle: key.of(student.id), student }))
    .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0))
}

/** "First Last", else the profile's name, else "Student". */
export function displayName(student: db.RosterStudent): string {
  const full = [student.firstName, student.lastName].map((p) => p?.trim() ?? '').filter(Boolean).join(' ')
  return full || student.name?.trim() || 'Student'
}

/** course.roster: handles only. */
export async function rosterHandles(installationId: string, sectionId: string): Promise<{ handle: string }[] | null> {
  const key = await loadHandleKey(installationId)
  const roster = key && (await loadHandleRoster(key, sectionId))
  return roster ? roster.map((r) => ({ handle: r.handle })) : null
}

/** The professor's page draws names over the frame from this map. The caller has
 * already checked the viewer is staff and the view declares course.roster. */
export async function rosterNames(installationId: string, sectionId: string): Promise<Record<string, string> | null> {
  const key = await loadHandleKey(installationId)
  const roster = key && (await loadHandleRoster(key, sectionId))
  return roster ? Object.fromEntries(roster.map((r) => [r.handle, displayName(r.student)])) : null
}
