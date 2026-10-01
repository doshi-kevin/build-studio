// Client-side redirect for the invite short-URL page. Runs
// window.location.replace() in useEffect so we can hand off to the
// Supabase /verify endpoint without a server-side 302 (and without
// dangerouslySetInnerHTML).
//
// We deliberately do NOT render an <a href={actionLink}> anywhere on this
// page. Email-client scanners (Gmail Safe Browsing, Apple Mail link
// previews, Outlook ATP, Resend click-tracking) parse the rendered HTML
// of any URL they're asked to scan and follow embedded anchors. Since
// actionLink points at Supabase's single-use /verify endpoint, an
// anchor here causes scanners to redeem the token before the user ever
// clicks. Keeping the redirect strictly inside useEffect (JS) defeats
// scanners that don't execute JavaScript.

'use client'

import { useEffect } from 'react'

interface Props {
  actionLink: string
}

export default function InviteRedirectClient({ actionLink }: Props) {
  useEffect(() => {
    window.location.replace(actionLink)
  }, [actionLink])

  return (
    <div
      style={{
        fontFamily: 'var(--font-geist-sans)',
        maxWidth: 500,
        margin: '80px auto',
        padding: '0 24px',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 8, color: '#111827' }}>
        Redirecting to Scholera…
      </h1>
      <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 20 }}>
        You&apos;ll be redirected to finish setting up your account.
      </p>
      <p style={{ fontSize: 13, color: '#6b7280' }}>
        Not redirected automatically? Refresh this page to try again.
      </p>
      <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 8 }}>
        Still stuck? Contact your institution admin.
      </p>
    </div>
  )
}
