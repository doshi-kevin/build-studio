/**
 * Public contact page.
 *
 * The landing footer and the "Talk to us" CTA both pointed here while the route did not
 * exist. Deliberately a plain page rather than a form: a form needs an inbox, spam
 * handling and a delivery guarantee, and support@scholera-inc.com is already the address
 * the product uses everywhere else (dashboard help, invitation emails).
 *
 * Type: Server Component
 * Route: /contact
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Mail, Globe } from 'lucide-react'
import { BrandMark } from '@/components/shared/BrandMark'

export const metadata: Metadata = {
  title: 'Contact — Scholera',
  description: 'Get in touch with the Scholera team.',
}

const SUPPORT_EMAIL = 'support@scholera-inc.com'

export default function ContactPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-14">
      <div className="mx-auto flex max-w-2xl flex-col gap-10">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-2 rounded-full text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Back to Scholera
        </Link>

        <div className="flex items-center gap-2.5">
          <BrandMark className="h-7 w-7" />
          <span className="font-serif text-[24px] tracking-tight text-foreground">
            Schol<em className="italic">era</em>
          </span>
        </div>

        <div className="space-y-3">
          <h1 className="font-serif text-[38px] leading-tight tracking-tight text-foreground">
            Talk to us
          </h1>
          <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Questions about bringing Scholera to your institution, a problem with your
            account, or something that isn&apos;t working — write to us and a person will
            reply.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-5 transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50">
              <Mail aria-hidden className="h-4 w-4 text-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Email us</p>
              <p className="truncate text-sm text-muted-foreground">{SUPPORT_EMAIL}</p>
            </div>
          </a>

          <a
            href="https://scholera-inc.com"
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-5 transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50">
              <Globe aria-hidden className="h-4 w-4 text-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Company site</p>
              <p className="truncate text-sm text-muted-foreground">scholera-inc.com</p>
            </div>
          </a>
        </div>

        <p className="text-[13px] text-muted-foreground">
          Already using Scholera?{' '}
          <Link
            href="/login"
            className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
          >
            Sign in
          </Link>{' '}
          — the help menu inside the app reaches the same inbox.
        </p>
      </div>
    </main>
  )
}
