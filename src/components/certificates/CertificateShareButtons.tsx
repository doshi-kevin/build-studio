/**
 * CertificateShareButtons — Add to LinkedIn / Copy link / Download PDF for a
 * certificate. Client component (clipboard + client-side PDF generation).
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Linkedin, Link2, Download, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buildLinkedInAddToProfileUrl } from '@/lib/certificates/linkedin'
import { downloadCertificatePdf } from '@/lib/certificates/pdf'

export interface CertificateShareData {
  publicId: string
  title: string
  studentName: string
  institutionName: string
  skills: string[]
  issuedAt: string
  /** Absolute, public URL of this certificate (certUrl + copy target). */
  shareUrl: string
}

export function CertificateShareButtons({ cert }: { cert: CertificateShareData }) {
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const linkedInUrl = buildLinkedInAddToProfileUrl({
    name: cert.title,
    organizationName: cert.institutionName,
    certUrl: cert.shareUrl,
    certId: cert.publicId,
    issuedAt: cert.issuedAt,
  })

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cert.shareUrl)
      setCopied(true)
      toast.success('Link copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy link')
    }
  }

  async function handleDownload() {
    setDownloading(true)
    try {
      await downloadCertificatePdf({
        studentName: cert.studentName,
        title: cert.title,
        institutionName: cert.institutionName,
        skills: cert.skills,
        issuedAt: cert.issuedAt,
        publicId: cert.publicId,
      })
    } catch {
      toast.error('Could not generate PDF')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button asChild>
        <a href={linkedInUrl} target="_blank" rel="noopener noreferrer">
          <Linkedin className="h-4 w-4" aria-hidden="true" />
          Add to LinkedIn
        </a>
      </Button>
      <Button variant="outline" onClick={handleCopy}>
        {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <Button variant="outline" onClick={handleDownload} disabled={downloading}>
        <Download className="h-4 w-4" aria-hidden="true" />
        {downloading ? 'Preparing…' : 'Download PDF'}
      </Button>
    </div>
  )
}
