// Admin Supabase architecture visual — shows how Supabase connects to the app,
// including client types, security layers, database schema map, and storage buckets.

import { SupabaseArchitectureVisual } from '@/components/admin/visual/SupabaseArchitectureVisual'

export default function VisualPage() {
  return (
    <div className="p-6 lg:p-10">
      <SupabaseArchitectureVisual />
    </div>
  )
}
