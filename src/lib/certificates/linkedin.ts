/**
 * LinkedIn "Add to Profile" deep link for a certificate.
 *
 * Deep-links the student to LinkedIn's Add-Certification form with fields
 * prefilled from the credential. Per Gate 2 we pass the issuing organization as
 * plain text (`organizationName`) — the student's institution — rather than a
 * LinkedIn Company Page id. All params except `startTask` are optional; whatever
 * we send prefills the form.
 *
 * Ref: https://addtoprofile.linkedin.com/
 */

export interface LinkedInCertParams {
  /** Certification name (the certificate title). */
  name: string
  /** Issuing organization, as plain text (the institution). */
  organizationName: string
  /** Public, crawlable URL of the certificate (also the OG-preview source). */
  certUrl: string
  /** Stable credential id (our public_id). */
  certId: string
  /** ISO issue date; split into year/month for LinkedIn. */
  issuedAt: string
}

export function buildLinkedInAddToProfileUrl(p: LinkedInCertParams): string {
  const issued = new Date(p.issuedAt)
  const params = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: p.name,
    organizationName: p.organizationName,
    certUrl: p.certUrl,
    certId: p.certId,
  })
  // Guard against an unparseable date — omit rather than send NaN.
  if (!Number.isNaN(issued.getTime())) {
    params.set('issueYear', String(issued.getUTCFullYear()))
    params.set('issueMonth', String(issued.getUTCMonth() + 1))
  }
  return `https://www.linkedin.com/profile/add?${params.toString()}`
}
