/**
 * Public certificate page — the shareable, unauthenticated credential.
 *
 * Route: /c/[publicId] (public: middleware protects only dashboard prefixes).
 * Reads via the admin client and returns ONLY a sanitized DTO (see
 * certificateQueries.getPublicCertificate) — never the raw row, no PII beyond
 * the earner's name. The unguessable public_id is the enumeration control.
 *
 * Type: Server Component
 */
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { certificateQueries } from '@/lib/supabase/queries'
import { getSiteUrl } from '@/lib/site-url'
import { CertificateView } from '@/components/certificates/CertificateView'
import { CertificateShareButtons } from '@/components/certificates/CertificateShareButtons'

export const dynamic = 'force-dynamic'

interface PublicCertPageProps {
  params: Promise<{ publicId: string }>
}

export async function generateMetadata({ params }: PublicCertPageProps): Promise<Metadata> {
  const { publicId } = await params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const cert = await certificateQueries.getPublicCertificate(adminDb, publicId)
  if (!cert) return { title: 'Certificate not found' }

  const title = `${cert.title} — ${cert.studentName}`
  const description = `${cert.studentName} earned ${cert.title} from ${cert.institutionName} on Scholera.`
  return {
    title,
    description,
    openGraph: { title, description, type: 'profile' },
    twitter: { card: 'summary_large_image', title, description },
  }
}

export default async function PublicCertificatePage({ params }: PublicCertPageProps) {
  const { publicId } = await params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const cert = await certificateQueries.getPublicCertificate(adminDb, publicId)
  if (!cert) notFound()

  const shareUrl = `${getSiteUrl()}/c/${cert.publicId}`

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-8 px-4 py-12">
      <CertificateView cert={cert} />
      <CertificateShareButtons
        cert={{
          publicId: cert.publicId,
          title: cert.title,
          studentName: cert.studentName,
          institutionName: cert.institutionName,
          skills: cert.skills,
          issuedAt: cert.issuedAt,
          shareUrl,
        }}
      />
      <p className="text-xs text-muted-foreground">
        Verified credential · Powered by Scholera
      </p>
    </main>
  )
}
