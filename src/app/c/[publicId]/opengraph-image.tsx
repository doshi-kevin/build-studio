/**
 * OG preview image for a public certificate (LinkedIn/social share card).
 * Uses next/og's ImageResponse (built into Next — no new dependency). Renders
 * from the same sanitized DTO as the page. Flexbox-only styling (Satori limit).
 */
import { ImageResponse } from 'next/og'
import { createAdminClient } from '@/lib/supabase/admin'
import { certificateQueries } from '@/lib/supabase/queries'

export const dynamic = 'force-dynamic'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function CertificateOgImage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const cert = await certificateQueries.getPublicCertificate(adminDb, publicId)

  const title = cert?.title ?? 'Certificate of Achievement'
  const studentName = cert?.studentName ?? ''
  const institutionName = cert?.institutionName ?? 'Scholera'

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
          color: '#f8fafc',
          padding: '64px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 26, letterSpacing: 4, color: '#94a3b8', textTransform: 'uppercase' }}>
          {institutionName}
        </div>
        <div style={{ fontSize: 42, marginTop: 24, color: '#cbd5e1' }}>Certificate of Achievement</div>
        {studentName && (
          <div style={{ fontSize: 30, marginTop: 40, color: '#e2e8f0' }}>{`Awarded to ${studentName}`}</div>
        )}
        <div style={{ fontSize: 56, fontWeight: 700, marginTop: 16, maxWidth: 1000 }}>{title}</div>
        <div style={{ fontSize: 24, marginTop: 48, color: '#64748b' }}>Verified credential · Powered by Scholera</div>
      </div>
    ),
    { ...size },
  )
}
