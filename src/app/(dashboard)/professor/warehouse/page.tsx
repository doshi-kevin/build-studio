/**
 * My Library (Knowledge Warehouse) — WITHDRAWN, not yet shipped.
 *
 * This surface was reachable from the professor sidebar while its persistence layer was
 * still a mock: `src/lib/warehouse/storage.ts` writes to fixed localStorage keys and its
 * own header describes itself as a mock "that can be swapped for Supabase later". The
 * consequences were real — nothing ever reached the server, clearing site data destroyed
 * every file record, a second account on the same browser saw the first professor's
 * library, and deleting a file here removed the shared Storage object out from under any
 * live course module using it.
 *
 * So the route is closed off at the door rather than left half-working. The components,
 * reducer and repository interface are all left in place: the interface is already the
 * right shape, so the rebuild is a matter of implementing it against Supabase.
 *
 * Re-enable by restoring the sidebar entry in `src/components/dashboard/Sidebar.tsx` and
 * deleting this guard — in the same change that lands the real repository.
 *
 * Type: Server Component
 * Route: /professor/warehouse (intentionally unreachable)
 */

import { notFound } from 'next/navigation'

export default function WarehousePage() {
  notFound()
}
