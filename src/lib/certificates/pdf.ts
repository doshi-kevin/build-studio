// Client-side certificate PDF. Uses a dynamic jspdf import (same pattern as
// src/lib/export/project-plan.ts) so jspdf stays out of the initial bundle.

export interface CertificatePdfData {
  studentName: string
  title: string
  institutionName: string
  skills: string[]
  issuedAt: string
  publicId: string
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'certificate'
}

export async function downloadCertificatePdf(data: CertificatePdfData): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const centerX = pageWidth / 2

  // Border
  doc.setDrawColor(120, 120, 120)
  doc.setLineWidth(0.8)
  doc.rect(10, 10, pageWidth - 20, pageHeight - 20)
  doc.setLineWidth(0.3)
  doc.rect(14, 14, pageWidth - 28, pageHeight - 28)

  doc.setTextColor(40, 40, 40)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(data.institutionName.toUpperCase(), centerX, 32, { align: 'center' })

  doc.setFontSize(26)
  doc.text('Certificate of Achievement', centerX, 52, { align: 'center' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12)
  doc.setTextColor(90, 90, 90)
  doc.text('This certifies that', centerX, 70, { align: 'center' })

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(24)
  doc.setTextColor(30, 30, 30)
  doc.text(data.studentName, centerX, 84, { align: 'center' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12)
  doc.setTextColor(90, 90, 90)
  doc.text('has successfully earned', centerX, 98, { align: 'center' })

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(30, 30, 30)
  const titleLines = doc.splitTextToSize(data.title, pageWidth - 80) as string[]
  doc.text(titleLines, centerX, 112, { align: 'center' })

  let y = 112 + titleLines.length * 8 + 8
  if (data.skills.length > 0) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(110, 110, 110)
    const skillsLine = `Skills demonstrated: ${data.skills.join(' · ')}`
    const skillLines = doc.splitTextToSize(skillsLine, pageWidth - 80) as string[]
    doc.text(skillLines, centerX, y, { align: 'center' })
    y += skillLines.length * 5
  }

  const issued = new Date(data.issuedAt)
  const issuedLabel = Number.isNaN(issued.getTime())
    ? ''
    : issued.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  doc.setFontSize(9)
  doc.setTextColor(130, 130, 130)
  doc.text(`Issued ${issuedLabel}`, 24, pageHeight - 20)
  doc.text(`Credential ID: ${data.publicId}`, pageWidth - 24, pageHeight - 20, { align: 'right' })

  doc.save(`${sanitizeFilename(data.title)}-certificate.pdf`)
}
