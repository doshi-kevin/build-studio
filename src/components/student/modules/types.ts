/**
 * Exactly what the student Modules surface needs from the database — and
 * nothing more.
 *
 * The page previously did `select('*')`, which put `instructor_note` (private
 * teaching notes) and other professor-only columns into the RSC payload that
 * ships to the browser. Narrowing here makes the query's column list a type
 * error to widen by accident.
 */

import type { Module, ModuleItem } from '@/lib/supabase/types'

export type StudentModule = Pick<
  Module,
  'id' | 'title' | 'description' | 'week_number' | 'position' | 'unlock_date'
>

export type StudentModuleItem = Pick<
  ModuleItem,
  'id' | 'module_id' | 'item_type' | 'title' | 'description' | 'content' | 'position'
>

/** Column lists for the queries, kept next to the types they produce.
 *
 *  `unlock_date` is safe to ship and has to be: a week that hasn't opened is drawn
 *  dimmed with "Opens Aug 6" rather than hidden, so the student can see the course
 *  continues. Its CONTENTS are what's withheld — the page never fetches items for
 *  a locked module (see lib/modules/unlock.ts). */
export const STUDENT_MODULE_COLUMNS = 'id, title, description, week_number, position, unlock_date'
export const STUDENT_MODULE_ITEM_COLUMNS =
  'id, module_id, item_type, title, description, content, position'
