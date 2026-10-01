/**
 * Department Not Found — shown when navigating to a non-existent department ID,
 * or one belonging to another institution (the detail page's cross-tenant guard
 * calls notFound() too, deliberately masking a 403 as a 404).
 *
 * Kept as its own boundary rather than falling through to (dashboard)/not-found
 * so the exit lands on the departments list instead of the dashboard.
 *
 * Type: Server Component (static UI, no data fetching)
 * Route: /admin/departments/[departmentId] (not found state)
 */

import { Building2 } from 'lucide-react'
import { DeadEnd } from '@/components/ui/dead-end'

export default function DepartmentNotFound() {
  return (
    <DeadEnd
      icon={Building2}
      title="Department not found"
      description="It may have been deleted, or you may not have access to it."
      action={{ label: 'Back to departments', href: '/admin/departments' }}
    />
  )
}
