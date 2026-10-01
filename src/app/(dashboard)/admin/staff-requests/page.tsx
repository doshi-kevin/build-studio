// Legacy URL — the staff-requests queue now lives as a tab inside the
// unified TAs & Graders hub. Redirect any deep links / bookmarks /
// notification emails over to the new home.
import { redirect } from 'next/navigation'

export default function AdminStaffRequestsPage() {
  redirect('/admin/staff?tab=requests')
}
