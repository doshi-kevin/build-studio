// Zod schema + cap for super_admin → super_admin invitations.
// Mirrors the institution-admin invite shape (name + email) but used at
// the platform tier — invitees become super_admins, not institution_admins.

import { z } from 'zod'

export const inviteSuperAdminSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200, 'Name must be 200 characters or fewer'),
  email: z.string().trim().email('Invalid email'),
})

export type InviteSuperAdminInput = z.infer<typeof inviteSuperAdminSchema>

/** Hard cap on super_admin count platform-wide. Counts include pending
 *  invites so a flood of unaccepted invitations can't bypass the limit. */
export const MAX_SUPER_ADMINS = 5
