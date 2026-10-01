// Shared labels, badge variants, and hover tooltips for the invite_status
// lifecycle (`pending → accepted → active`, plus terminal `revoked`).
//
// Used by Professor and Student admin views so the badge looks and reads the
// same regardless of who's being invited. Tooltip copy is role-neutral on
// purpose — keeps the strings in one place and "they / their" reads fine
// for both populations.

/** Badge text for each invite_status value. */
export const INVITE_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending Invite',
  accepted: 'Onboarding',
  revoked: 'Invite Revoked',
}

/** shadcn Badge variant per state. */
export const INVITE_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  pending: 'outline',
  accepted: 'secondary',
  revoked: 'destructive',
}

/** Hover tooltip — role-neutral so we don't fork strings per audience. */
export const INVITE_STATUS_TOOLTIPS: Record<string, string> = {
  pending: 'Invite sent — waiting for them to log in and set their password.',
  accepted: 'Password set — they\'re getting started in Scholera.',
  revoked: 'Admin revoked this invite. They cannot log in.',
}
