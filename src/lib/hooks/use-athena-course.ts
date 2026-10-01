'use client'

/**
 * Which course Athena is currently answering about — design doc §14.7 D1.
 *
 * The shell used to live in the course layout, which handed it a `sectionId`,
 * a `courseCode` and the professor's feature toggle as props. That stops
 * working the moment she drives somewhere outside a course: `/student/
 * office-hours` is a sibling route, so the layout unmounts and the student
 * arrives at a pre-filled booking form with no Athena attached to it. The shell
 * therefore moved up to `/student/layout.tsx`, where nothing unmounts.
 *
 * That leaves the shell above the segment that knows which course this is. The
 * fix is not a fetch: the course layout already resolves all three values on
 * the server, with the enrollment check it was doing anyway, so it simply
 * announces them (see `AthenaCourseBeacon`) and the shell subscribes. No extra
 * round trip, no new authorization surface, and no chance of the client picking
 * a section the server never checked.
 *
 * Outside a course nothing announces, so the last announcement stands — which
 * is exactly the behaviour C10 needs: she follows the student to the booking
 * page still knowing the course they came from. A student who has not opened a
 * course this session has no announcement at all, and Athena stays off screen,
 * which is what happens today anyway.
 *
 * `sessionStorage`, not `localStorage`: per tab, like the pre-fill handoff. Two
 * tabs on two courses must not overwrite each other's context.
 */

import { useSyncExternalStore } from 'react'

const KEY = 'athena-course'
const EVENT = 'scholera:athena-course'

export interface AthenaCourse {
  sectionId: string
  /** "CS584" — the entry pill wears it. */
  courseCode: string
  /** The professor's toggle for this section, resolved server-side. */
  enabled: boolean
}

/** Nothing announced yet. A stable reference, because `useSyncExternalStore`
 *  compares snapshots by identity and a fresh object every read is an infinite
 *  render loop. */
const NONE: AthenaCourse | null = null

/** Last raw string seen, and the object parsed from it — same reason. */
let cachedRaw: string | null = null
let cachedCourse: AthenaCourse | null = null

function readCourse(): AthenaCourse | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(KEY)
  } catch {
    return NONE
  }
  if (raw === cachedRaw) return cachedCourse
  cachedRaw = raw
  cachedCourse = null
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<AthenaCourse>
      if (typeof parsed.sectionId === 'string' && parsed.sectionId) {
        cachedCourse = {
          sectionId: parsed.sectionId,
          courseCode: typeof parsed.courseCode === 'string' ? parsed.courseCode : '',
          enabled: parsed.enabled === true,
        }
      }
    } catch {
      // A corrupt entry reads as "no course" — Athena stays off screen rather
      // than attaching herself to a section we can't name.
    }
  }
  return cachedCourse
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** Called by the course layout's beacon on every course page. */
export function announceAthenaCourse(course: AthenaCourse): void {
  const next = JSON.stringify(course)
  try {
    // Re-announcing the same course must not wake every subscriber on each
    // navigation within the course.
    if (sessionStorage.getItem(KEY) === next) return
    sessionStorage.setItem(KEY, next)
  } catch {
    return
  }
  window.dispatchEvent(new CustomEvent(EVENT))
}

/**
 * The course Athena is attached to, or null when the student hasn't opened one
 * this session. Server-rendered as null so SSR and hydration agree, with the
 * stored value landing on the first post-hydration read (cf.
 * `useAthenaDriveMode`).
 */
export function useAthenaCourse(): AthenaCourse | null {
  return useSyncExternalStore(subscribe, readCourse, () => NONE)
}
