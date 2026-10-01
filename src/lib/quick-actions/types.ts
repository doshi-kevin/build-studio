// TypeScript types for the professor Quick Actions system.
// Defines the shape of each quick action entry in the registry.

import type { LucideIcon } from 'lucide-react'

export interface QuickAction {
  /** Unique identifier for the action */
  id: string
  /** Display label shown on the button */
  label: string
  /** Short description shown below the label */
  description: string
  /** Lucide icon component */
  icon: LucideIcon
  /** Accent color class for the icon (e.g., 'text-blue-600') */
  color: string
  /** Background class for the icon container (e.g., 'bg-blue-500/10') */
  iconBg: string
  /** Function that generates the target route given a sectionId */
  route: (sectionId: string) => string
  /**
   * The product this action needs, when it needs one. An action whose feature
   * the institution has not bought is not rendered: its route would dead-end,
   * and offering a button that cannot work is worse than offering nothing.
   * Actions on Platform surfaces (announcements, grades, modules, about) leave
   * this unset and always show.
   */
  feature?: 'quizzes' | 'assignments' | 'live-classroom' | 'projects' | 'discussions' | 'challenges' | 'athena'
}

export interface CourseSection {
  id: string
  section_code: string
  course: {
    id: string
    code: string
    title: string
  } | null
}
