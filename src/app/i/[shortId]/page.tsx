// Invite redirect endpoint — resolves a short_id from invite_redirects and
// redirects the user to the stored action_link via client-side JavaScript.
// Client-side redirect is intentional: it keeps the whole auth handoff on
// our domain (app.scholera-inc.com) so email-client link-wrappers (Resend
// click-tracking, Gmail Safe Links, Outlook ATP) only see the short URL —
// never the Supabase /verify endpoint that carries the single-use token.
// That indirection is the whole point.

import { MailX } from 'lucide-react'
import { resolveInviteRedirect } from '@/lib/invite-redirects'
import { logger } from '@/lib/logger'
import { BrandMark } from '@/components/shared/BrandMark'
import { DeadEnd } from '@/components/ui/dead-end'
import InviteRedirectClient from './InviteRedirectClient'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface Props {
  params: Promise<{ shortId: string }>
}

export default async function InviteRedirectPage({ params }: Props) {
  const { shortId } = await params
  const result = await resolveInviteRedirect(shortId)

  if (result.status !== 'ok') {
    const copy: Record<string, { title: string; message: string }> = {
      not_found: {
        title: 'Link not found',
        message:
          'This invitation link is invalid or has already been used. Ask your admin to resend.',
      },
      revoked: {
        title: 'Link revoked',
        message: 'This invitation has been revoked. Ask your admin to issue a new one.',
      },
      expired: {
        title: 'Link expired',
        message: 'This invitation has expired. Ask your admin to resend.',
      },
    }
    const { title, message } = copy[result.status]
    logger.warn('InviteRedirectPage: unusable link', { shortId, status: result.status })
    return <InviteLinkErrorState title={title} message={message} />
  }

  return <InviteRedirectClient actionLink={result.actionLink} />
}

/**
 * An unusable invite link is a dead end, so it renders the shared DeadEnd rather
 * than its own markup. Supplies a full-page frame + brand mark because this route
 * sits outside the dashboard chrome, same as the root not-found boundary.
 */
function InviteLinkErrorState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4">
      <BrandMark className="h-8 w-8" />
      <DeadEnd
        icon={MailX}
        title={title}
        description={message}
        action={{ label: 'Go to login', href: '/login' }}
      />
    </div>
  )
}
