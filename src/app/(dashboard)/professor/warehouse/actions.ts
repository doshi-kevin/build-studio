/**
 * Warehouse Server Actions — fetch professor's course sections for library shelves.
 */
'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

interface CourseSectionForWarehouse {
  id: string
  semester: string
  year: number
  course: { id: string; code: string; title: string } | null
}

/**
 * Fetch the current professor's course sections with joined course info.
 * Returns an array of sections used to build warehouse shelves.
 */
export async function getProfessorCourseSections(): Promise<CourseSectionForWarehouse[]> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data, error } = await adminDb
      .from('course_sections')
      .select('id, semester, year, course:courses(id, code, title)')
      .eq('professor_id', user.id)
      .order('year', { ascending: false })

    if (error) {
      logger.error('getProfessorCourseSections: Fetch failed', error)
      return []
    }

    return (data || []) as CourseSectionForWarehouse[]
  } catch (error) {
    logger.error('getProfessorCourseSections: Unexpected error', error)
    return []
  }
}
