// Professor Quick Actions registry — single source of truth for all dashboard quick actions.
// Add new entries here when building new features; the dashboard picks them up automatically.

import {
  ClipboardCheck,
  Megaphone,
  Upload,
  FileText,
  GraduationCap,
  Presentation,
} from 'lucide-react'
import type { QuickAction } from './types'

// Ordered by how often instructors actually reach for each one. Announcements
// are the most-used LMS tool by a wide margin (present in ~82% of courses,
// ahead of grades and assignments), and grading is the single largest
// consumer of teaching time — so those two lead.
export const PROFESSOR_QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'post-announcement',
    label: 'Post an Announcement',
    description: 'Share updates with your class',
    icon: Megaphone,
    color: 'text-foreground',
    iconBg: 'border border-border bg-muted/50',
    route: (sectionId) => `/professor/courses/${sectionId}/announcements?action=create`,
  },
  {
    id: 'grade-submissions',
    label: 'Grade Submissions',
    description: 'Review and grade student work',
    icon: GraduationCap,
    color: 'text-foreground',
    iconBg: 'border border-border bg-muted/50',
    route: (sectionId) => `/professor/courses/${sectionId}/grades`,
  },
  {
    id: 'start-class',
    label: 'Start a Class',
    description: 'Open the live classroom for this section',
    icon: Presentation,
    color: 'text-foreground',
    iconBg: 'border border-border bg-muted/50',
    route: (sectionId) => `/professor/courses/${sectionId}/live-classroom`,
    feature: 'live-classroom',
  },
  {
    id: 'create-quiz',
    label: 'Create a Quiz',
    description: 'Build a new assessment for your students',
    icon: ClipboardCheck,
    color: 'text-foreground',
    iconBg: 'border border-border bg-muted/50',
    route: (sectionId) => `/professor/courses/${sectionId}/quizzes?action=create`,
    feature: 'quizzes',
  },
  {
    id: 'upload-material',
    label: 'Upload Lecture Material',
    description: 'Add content to your course modules',
    icon: Upload,
    color: 'text-foreground',
    iconBg: 'border border-border bg-muted/50',
    route: (sectionId) => `/professor/courses/${sectionId}/modules?action=create`,
  },
  {
    id: 'setup-about',
    label: 'Set Up About Page',
    description: 'Customize your course landing page',
    icon: FileText,
    color: 'text-foreground',
    iconBg: 'border border-border bg-muted/50',
    route: (sectionId) => `/professor/courses/${sectionId}/about`,
  },
]
