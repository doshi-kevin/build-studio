// Zod schema for institution_admin → institution_admin invitations.
// Used by the /admin/admins page where existing admins can grow their team.
// Distinct from inviteAdminSchema (super_admin path) because this one doesn't
// take an institutionId — the caller's tenant is derived server-side from
// verifyInstitutionAdmin().

import { z } from 'zod'

export const inviteCoAdminSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200, 'Name must be 200 characters or fewer'),
  email: z.string().trim().email('Invalid email'),
})

export type InviteCoAdminInput = z.infer<typeof inviteCoAdminSchema>

/** Hard cap on institution_admin count per institution. Counts include pending
 *  invites so the cap can't be trivially bypassed by inviting many people who
 *  haven't accepted yet. */
export const MAX_ADMINS_PER_INSTITUTION = 5
