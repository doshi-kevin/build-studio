/**
 * Email Service — sends transactional emails via Resend.
 *
 * Used for:
 * - Sending student login credentials (CWID + password) after account creation
 * - Sending professor welcome emails with login instructions
 *
 * Requires RESEND_API_KEY in environment variables.
 * Free tier: 100 emails/day, 3000/month — sufficient for demo and development.
 *
 * Sends from noreply@scholera-inc.com using a verified domain in Resend.
 * Also configured as Supabase custom SMTP for auth emails (invites, password resets).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resend } from 'resend'
import { logger } from '@/lib/logger'
import { getSiteUrl } from '@/lib/site-url'

/** Resend client — initialized lazily to avoid errors when API key is missing */
function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    logger.warn('Email: RESEND_API_KEY not configured — emails will not be sent')
    return null
  }
  return new Resend(apiKey)
}

/** Default sender address — uses verified scholera-inc.com domain via Resend. */
const EMAIL_FROM = process.env.EMAIL_FROM || 'Scholera <noreply@scholera-inc.com>'

/**
 * The Scholera logo, embedded INLINE (CID attachment) rather than hot-linked. Mail
 * clients block external images by default (Outlook / O365 especially), which turns a
 * hosted <img src="https://…/logo.png"> into a broken-image icon; an inline attachment
 * travels with the message and renders regardless. Read once from /public and cached.
 * Referenced in the HTML as <img src="cid:scholera-logo">. If the file can't be read,
 * getLogoAttachment() returns null and the header falls back to the text wordmark alone.
 */
const LOGO_CID = 'scholera-logo'
let logoAttachmentCache: { filename: string; content: Buffer; contentId: string } | null | undefined
function getLogoAttachment() {
  if (logoAttachmentCache !== undefined) return logoAttachmentCache
  try {
    logoAttachmentCache = {
      filename: 'scholera-logo.png',
      content: readFileSync(join(process.cwd(), 'public', 'logo.png')),
      contentId: LOGO_CID,
    }
  } catch (error) {
    logger.warn('Email: could not read logo for inline attachment', {
      error: error instanceof Error ? error.message : String(error),
    })
    logoAttachmentCache = null
  }
  return logoAttachmentCache
}

/** The logo <img> (cid-referenced) when the inline attachment is available, else '' (text wordmark only). */
function logoImgTag(): string {
  return getLogoAttachment()
    ? `<img src="cid:${LOGO_CID}" width="44" height="44" alt="Scholera" style="display: inline-block; vertical-align: middle; border-radius: 8px;" />`
    : ''
}

/**
 * Minimal HTML escape for values interpolated into email markup (student names,
 * course labels, professor-authored reasons). Prevents markup injection into the
 * email body. The `&` replacement MUST run first so the entities produced by the
 * later replacements are not themselves re-escaped.
 */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Renders a one-time secret (temporary password) with a copy affordance. The
 * dashed underline signals "this value is meant to be grabbed", and
 * `user-select: all` makes a single click select the whole string in clients
 * that honour it (Apple Mail, Thunderbird). Gmail strips `user-select`, where
 * the dashed hint still reads as "copy this" — so the hint is the durable part
 * and the one-click select is the bonus. Escaped because a generated password
 * is still an untrusted string in HTML position.
 */
function selectableSecret(value: string): string {
  return `<span style="font-family: monospace; font-weight: 600; user-select: all; -webkit-user-select: all; border-bottom: 1px dashed #9ca3af; padding-bottom: 1px;">${escapeHtml(value)}</span>`
}

/**
 * Looks up the current platform owner's email so admin-tier invites can
 * be CC'd to them for auditability. Returns null if no owner exists or
 * the lookup fails — in either case the caller falls back to sending
 * without CC rather than failing the whole invite.
 */
// Platform-owner CC was removed: the invite body contains a temporary
// password and CCing the owner leaked that secret in transit, even
// though the recipient is forced to reset on first login. Audit trail
// for super-admin / institution-admin invites should come from the
// `events` table on the server, not from a personal inbox copy.

/**
 * Sends login credentials to a newly created student.
 *
 * @param to - Student's email address
 * @param name - Student's full name
 * @param cwid - 8-digit Campus-Wide ID (login identifier); null for accounts
 *               created without one (bulk roster import) — they log in by email
 * @param password - Auto-generated password
 * @returns true if sent successfully, false otherwise
 */
export async function sendStudentCredentials(
  to: string,
  name: string,
  cwid: string | null,
  password: string
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendStudentCredentials: Skipped — no email client configured', { to, cwid })
    return false
  }

  try {
    const loginUrl = getSiteUrl()

    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: 'Welcome to Scholera — Your Login Credentials',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 24px; margin-bottom: 8px;">Welcome to Scholera</h1>
          <p style="color: #6b7280; font-size: 16px; margin-bottom: 24px;">
            Hi ${escapeHtml(name)}, your student account has been created. Use the credentials below to log in.
          </p>

          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 160px;">Email</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px; font-family: monospace; font-weight: 600;">${to}</td>
              </tr>
              ${cwid ? `<tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Student ID (CWID)</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px; font-family: monospace; font-weight: 600;">${cwid}</td>
              </tr>` : ''}
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Temporary password</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px;">${selectableSecret(password)}</td>
              </tr>
            </table>
          </div>

          <a href="${loginUrl}/login" style="display: inline-block; background: #111827; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500;">
            Log In to Scholera
          </a>

          <p style="color: #9ca3af; font-size: 13px; margin-top: 24px;">
            Sign in with your email and the temporary password above. You'll be asked to set a new password on your first login.
          </p>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            This is an automated message from Scholera. If you did not expect this email, please contact your administrator.
          </p>
        </div>
      `,
    })

    if (error) {
      logger.error('sendStudentCredentials: Failed', error, { to, cwid })
      return false
    }

    logger.info('sendStudentCredentials: Sent', { to, cwid })
    return true
  } catch (error) {
    logger.error('sendStudentCredentials: Exception', error, { to, cwid })
    return false
  }
}

/**
 * Sends the welcome email to a newly created professor.
 *
 * If `tempPassword` is provided, the email shows the temporary password and
 * tells the professor to log in with email + password — the app then forces
 * them to set a permanent password on first login (via the
 * `requires_password_set` app_metadata flag). This avoids the magic-link
 * fragility (email clients mangling Supabase action_links via Safe-Browsing
 * scanners and click-tracking).
 *
 * Omit `tempPassword` only when the professor already has a password (e.g.
 * adding an existing user to a new department); the template falls back to
 * plain login instructions.
 */
/**
 * Sends a welcome email to a newly invited platform super_admin (the
 * Scholera team tier — not an institution admin). Includes login + temp
 * password and notes that the recipient will be forced through the set-
 * password flow on first login.
 */
export async function sendSuperAdminWelcome(
  to: string,
  name: string,
  opts: { tempPassword: string; isPlatformOwner: boolean }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendSuperAdminWelcome: Skipped — no email client configured', { to })
    return false
  }

  try {
    const loginUrl = getSiteUrl()
    const greeting = name
      ? `<p style="color: #111827; font-size: 16px; margin: 0 0 16px 0;">Hi ${escapeHtml(name)},</p>`
      : ''
    const roleLine = opts.isPlatformOwner
      ? `<p style="color: #374151; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">You've been added as the <strong>Platform Owner</strong> on Scholera. This is the highest level of access — you can invite and remove other Super Admins, and hand the Platform Owner role over to someone else whenever you need to.</p>`
      : `<p style="color: #374151; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">You've been added as a <strong>Super Admin</strong> on Scholera. This means you can oversee every university we work with, add new ones, and manage the people who run them on each campus.</p>`
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: 'Welcome to Scholera — your Super Admin access is ready',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 24px; margin-bottom: 16px;">Welcome to Scholera</h1>
          ${greeting}
          ${roleLine}
          <p style="color: #374151; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
            To get started, sign in with the details below.
          </p>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 160px;">Email</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px; font-family: monospace; font-weight: 600;">${to}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Temporary password</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px;">${selectableSecret(opts.tempPassword)}</td>
              </tr>
            </table>
          </div>
          <div style="margin-bottom: 20px;">
            <a href="${loginUrl}/login" style="display: inline-block; background: #111827; color: #ffffff; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Sign in to Scholera</a>
          </div>
          <p style="color: #6b7280; font-size: 13px; margin: 0 0 24px 0;">
            For your security, we'll ask you to set a new password the first time you sign in.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px; line-height: 1.6;">
            This is an automated message from Scholera. If you weren't expecting this invitation, write to <a href="mailto:support@scholera-inc.com" style="color: #6b7280;">support@scholera-inc.com</a> and we'll take care of it.
          </p>
        </div>
      `,
    })

    if (error) {
      logger.error('sendSuperAdminWelcome: Failed', error, { to })
      return false
    }
    logger.info('sendSuperAdminWelcome: Sent', { to, isPlatformOwner: opts.isPlatformOwner })
    return true
  } catch (error) {
    logger.error('sendSuperAdminWelcome: Exception', error, { to })
    return false
  }
}

export async function sendInstitutionAdminWelcome(
  to: string,
  name: string,
  opts: { institutionName: string; tempPassword: string }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendInstitutionAdminWelcome: Skipped — no email client configured', { to })
    return false
  }

  try {
    const loginUrl = getSiteUrl()
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Welcome to Scholera — ${opts.institutionName} on Scholera`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 24px; margin-bottom: 8px;">Welcome to Scholera</h1>
          <p style="color: #6b7280; font-size: 16px; margin-bottom: 24px;">
            Hi ${escapeHtml(name)}, your institution admin account for <strong>${escapeHtml(opts.institutionName)}</strong> has been created.
            You're now in charge of departments, professors, courses, programs, students, and TAs at your institution.
          </p>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 160px;">Login Email</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px; font-family: monospace; font-weight: 600;">${to}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Temporary Password</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px;">${selectableSecret(opts.tempPassword)}</td>
              </tr>
            </table>
          </div>
          <div style="margin-bottom: 20px;">
            <a href="${loginUrl}/login" style="display: inline-block; background: #111827; color: #ffffff; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Log in to Scholera</a>
          </div>
          <p style="color: #6b7280; font-size: 13px; margin: 0 0 24px 0;">
            For your security, you'll be asked to set a new password right after you log in.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            This is an automated message from Scholera. Didn't expect this invitation? Write to <a href="mailto:support@scholera-inc.com" style="color: #9ca3af;">support@scholera-inc.com</a> and let us know.
          </p>
        </div>
      `,
    })

    if (error) {
      logger.error('sendInstitutionAdminWelcome: Failed', error, { to })
      return false
    }
    logger.info('sendInstitutionAdminWelcome: Sent', { to, institutionName: opts.institutionName })
    return true
  } catch (error) {
    logger.error('sendInstitutionAdminWelcome: Exception', error, { to })
    return false
  }
}

export async function sendProfessorWelcome(
  to: string,
  name: string,
  opts: { tempPassword?: string } = {}
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendProfessorWelcome: Skipped — no email client configured', { to })
    return false
  }

  try {
    const loginUrl = getSiteUrl()

    const ctaBlock = opts.tempPassword
      ? `
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 160px;">Login Email</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px; font-family: monospace; font-weight: 600;">${to}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Temporary Password</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px;">${selectableSecret(opts.tempPassword)}</td>
              </tr>
            </table>
          </div>
          <div style="margin-bottom: 20px;">
            <a href="${loginUrl}/login" style="display: inline-block; background: #111827; color: #ffffff; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Log in to Scholera</a>
          </div>
          <p style="color: #6b7280; font-size: 13px; margin: 0 0 24px 0;">
            For your security, you'll be asked to set a new password right after you log in.
          </p>
        `
      : `
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;">
              <strong>Login Email:</strong> <span style="font-family: monospace;">${to}</span>
            </p>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">
              Sign in with your existing Scholera password. If you've forgotten it, use the "Forgot Password" option on the login page.
            </p>
          </div>
          <p style="color: #374151; font-size: 14px; margin: 0 0 24px 0;">
            Sign in at <a href="${loginUrl}/login" style="color: #111827; font-weight: 600;">${loginUrl}/login</a>.
          </p>
        `

    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: 'Welcome to Scholera — Professor Account Created',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 24px; margin-bottom: 8px;">Welcome to Scholera</h1>
          <p style="color: #6b7280; font-size: 16px; margin-bottom: 24px;">
            Hi ${escapeHtml(name)}, your professor account has been created on Scholera.
          </p>

          ${ctaBlock}

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            This is an automated message from Scholera. Didn't expect this invitation? Contact your institution admin.
          </p>
        </div>
      `,
    })

    if (error) {
      logger.error('sendProfessorWelcome: Failed', error, { to })
      return false
    }

    logger.info('sendProfessorWelcome: Sent', { to, withTempPassword: !!opts.tempPassword })
    return true
  } catch (error) {
    logger.error('sendProfessorWelcome: Exception', error, { to })
    return false
  }
}

/**
 * Sends the welcome email to a newly approved TA or grader.
 *
 * If `tempPassword` is provided, the email shows the temp credentials and
 * tells them to log in with email + password — the app then forces a
 * password reset on first login (via the `requires_password_set` app_metadata
 * flag). This avoids the magic-link fragility (email scanners + click
 * tracking would silently consume Supabase's single-use action_link before
 * the user ever clicked).
 *
 * Omit `tempPassword` only for the "promoted existing student" path — that
 * user already has a password.
 */
export async function sendStaffWelcome(
  to: string,
  name: string,
  opts: {
    role: 'ta' | 'grader'
    courseLabel: string
    professorName: string
    endsAt: string
    tempPassword?: string
  }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendStaffWelcome: Skipped — no email client configured', { to })
    return false
  }

  try {
    const roleLabel = opts.role === 'ta' ? 'Teaching Assistant' : 'Grader'
    const endsLabel = new Date(opts.endsAt).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const roleDescription = opts.role === 'ta'
      ? 'You can post announcements, grade submissions, moderate discussions, and support students during office hours.'
      : 'Your role is focused on grading — you will review and grade student submissions for this course.'

    const loginUrl = getSiteUrl()

    const ctaBlock = opts.tempPassword
      ? `
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 160px;">Login Email</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px; font-family: monospace; font-weight: 600;">${to}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Temporary Password</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px;">${selectableSecret(opts.tempPassword)}</td>
              </tr>
            </table>
          </div>
          <div style="margin-bottom: 20px;">
            <a href="${loginUrl}/login" style="display: inline-block; background: #111827; color: #ffffff; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Log in to Scholera</a>
          </div>
          <p style="color: #6b7280; font-size: 13px; margin: 0 0 24px 0;">
            For your security, you'll be asked to set a new password right after you log in.
          </p>
        `
      : `
          <p style="color: #374151; font-size: 14px; margin: 0 0 24px 0;">
            Sign in to <a href="${loginUrl}/login" style="color: #111827; font-weight: 600;">Scholera</a> with your existing password — your new ${roleLabel.toLowerCase()} access for ${escapeHtml(opts.courseLabel)} is already live.
          </p>
        `

    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Welcome to Scholera — ${roleLabel} for ${opts.courseLabel}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 24px; margin-bottom: 8px;">Welcome to Scholera</h1>
          <p style="color: #6b7280; font-size: 16px; margin-bottom: 24px;">
            Hi ${escapeHtml(name)}, you've been approved as a <strong>${roleLabel}</strong> for <strong>${escapeHtml(opts.courseLabel)}</strong> by Prof. ${escapeHtml(opts.professorName)}.
          </p>

          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 12px 0;">
              <strong>Role:</strong> ${roleLabel}
            </p>
            <p style="color: #374151; font-size: 14px; margin: 0 0 12px 0;">
              <strong>Course:</strong> ${escapeHtml(opts.courseLabel)}
            </p>
            <p style="color: #374151; font-size: 14px; margin: 0 0 12px 0;">
              <strong>Access expires:</strong> ${endsLabel}
            </p>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">
              ${roleDescription}
            </p>
          </div>

          ${ctaBlock}

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            This is an automated message from Scholera. Didn't expect this invitation? Contact your institution admin.
          </p>
        </div>
      `,
    })

    if (error) {
      logger.error('sendStaffWelcome: Failed', error, { to })
      return false
    }

    logger.info('sendStaffWelcome: Sent', { to, role: opts.role, withTempPassword: !!opts.tempPassword })
    return true
  } catch (error) {
    logger.error('sendStaffWelcome: Exception', error, { to })
    return false
  }
}

/**
 * Sends a freshly-reset temporary password to a staff member whose original
 * credentials expired or got lost. Called from the admin "Resend invite"
 * action after we regenerate the password via auth.admin.updateUserById.
 * The user logs in with the new temp password, then is forced to set a
 * permanent one (via the requires_password_set flag in app_metadata).
 */
export async function sendStaffInviteLink(
  to: string,
  name: string,
  opts: {
    tempPassword: string
    role: 'ta' | 'grader'
    courseLabel: string
  }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendStaffInviteLink: Skipped — no email client configured', { to })
    return false
  }

  try {
    const roleLabel = opts.role === 'ta' ? 'Teaching Assistant' : 'Grader'
    const loginUrl = getSiteUrl()
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Your Scholera password has been reset — ${roleLabel} for ${opts.courseLabel}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 24px; margin-bottom: 8px;">Your password has been reset</h1>
          <p style="color: #6b7280; font-size: 16px; margin-bottom: 24px;">
            Hi ${escapeHtml(name)}, your Scholera admin issued you a new temporary password. Use the credentials below to log in. Any earlier passwords are no longer valid.
          </p>

          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;">
              <strong>Role:</strong> ${roleLabel}
            </p>
            <p style="color: #374151; font-size: 14px; margin: 0 0 16px 0;">
              <strong>Course:</strong> ${escapeHtml(opts.courseLabel)}
            </p>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 160px;">Login Email</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px; font-family: monospace; font-weight: 600;">${to}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Temporary Password</td>
                <td style="padding: 8px 0; color: #111827; font-size: 16px;">${selectableSecret(opts.tempPassword)}</td>
              </tr>
            </table>
          </div>

          <div style="margin-bottom: 20px;">
            <a href="${loginUrl}/login" style="display: inline-block; background: #111827; color: #ffffff; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Log in to Scholera</a>
          </div>
          <p style="color: #6b7280; font-size: 13px; margin: 0 0 24px 0;">
            For your security, you'll be asked to set a new password right after you log in.
          </p>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            Didn't expect this email? Contact your institution admin.
          </p>
        </div>
      `,
    })

    if (error) {
      logger.error('sendStaffInviteLink: Failed', error, { to })
      return false
    }
    logger.info('sendStaffInviteLink: Sent', { to, role: opts.role })
    return true
  } catch (error) {
    logger.error('sendStaffInviteLink: Exception', error, { to })
    return false
  }
}

/**
 * Notifies a TA/grader candidate that a professor submitted an application on
 * their behalf and it is now awaiting institution-admin approval. Sent at
 * submission time so the candidate isn't left silent until approval — until
 * this existed the first thing they heard was the welcome email days later.
 *
 * Deliberately contains NO credentials and NO login link: there is no account
 * yet, and an approval may never come. The only ask is "expect a follow-up".
 */
export async function sendStaffRequestSubmitted(
  to: string,
  candidateName: string,
  opts: { role: 'ta' | 'grader'; courseLabel: string; professorName: string }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendStaffRequestSubmitted: Skipped — no email client configured', { to })
    return false
  }

  try {
    const roleLabel = opts.role === 'ta' ? 'Teaching Assistant' : 'Grader'
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Your ${roleLabel} application for ${opts.courseLabel} is pending review`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 22px; margin-bottom: 8px;">Application submitted</h1>
          <p style="color: #6b7280; font-size: 15px; margin-bottom: 24px;">
            Hi ${escapeHtml(candidateName)}, ${escapeHtml(opts.professorName)} submitted an application for you to join <strong>${escapeHtml(opts.courseLabel)}</strong> on Scholera. Nothing is needed from you right now.
          </p>

          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 160px;">Role</td>
                <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 600;">${roleLabel}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Course</td>
                <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 600;">${escapeHtml(opts.courseLabel)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Status</td>
                <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 600;">Pending admin approval</td>
              </tr>
            </table>
          </div>

          <p style="color: #6b7280; font-size: 14px;">
            An institution admin reviews every application. We'll email you again once a decision is made — if it's approved, that email will include your login details.
          </p>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            Weren't expecting this? You can ignore this email — no account has been created. If it keeps happening, reply to ${escapeHtml(opts.professorName)} or contact the institution directly.
          </p>
        </div>
      `,
    })
    if (error) {
      logger.error('sendStaffRequestSubmitted: Failed', error, { to })
      return false
    }
    logger.info('sendStaffRequestSubmitted: Sent', { to, role: opts.role })
    return true
  } catch (error) {
    logger.error('sendStaffRequestSubmitted: Exception', error, { to })
    return false
  }
}

/**
 * Notifies a professor that their submitted TA/grader request was rejected.
 */
export async function sendStaffRequestRejected(
  to: string,
  professorName: string,
  opts: { candidateName: string; courseLabel: string; reason: string }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendStaffRequestRejected: Skipped — no email client configured', { to })
    return false
  }

  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Scholera — Course Assistant request for ${opts.courseLabel} was not approved`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 22px; margin-bottom: 8px;">Request not approved</h1>
          <p style="color: #6b7280; font-size: 15px; margin-bottom: 24px;">
            Hi ${escapeHtml(professorName)}, your request to onboard <strong>${escapeHtml(opts.candidateName)}</strong> for <strong>${escapeHtml(opts.courseLabel)}</strong> was not approved by the institution admin.
          </p>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;"><strong>Admin note:</strong></p>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">${escapeHtml(opts.reason)}</p>
          </div>
          <p style="color: #6b7280; font-size: 14px;">
            You can submit a new request with more context or a different candidate from your course's Staff tab.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">Automated message from Scholera.</p>
        </div>
      `,
    })
    if (error) {
      logger.error('sendStaffRequestRejected: Failed', error, { to })
      return false
    }
    logger.info('sendStaffRequestRejected: Sent', { to })
    return true
  } catch (error) {
    logger.error('sendStaffRequestRejected: Exception', error, { to })
    return false
  }
}

/**
 * Confirms an office-hours booking to the student who just booked it. Best-effort.
 *
 * @param to - Student's email
 * @param name - Student's name
 * @param opts.title - Booking title
 * @param opts.when - Human-readable date + time, e.g. "Mon, Jul 6 · 10:00–10:30"
 * @param opts.location - Optional location or meeting link text
 */
export async function sendBookingConfirmed(
  to: string,
  name: string,
  opts: { title: string; when: string; location?: string | null }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendBookingConfirmed: Skipped — no email client configured', { to })
    return false
  }

  const locationBlock = opts.location
    ? `<p style="color: #374151; font-size: 14px; margin: 0;"><strong>Where:</strong> ${escapeHtml(opts.location)}</p>`
    : ''
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Booking confirmed — ${opts.title}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 22px; margin-bottom: 8px;">Booking confirmed</h1>
          <p style="color: #6b7280; font-size: 15px; margin-bottom: 24px;">
            Hi ${escapeHtml(name)}, your office-hours booking is confirmed.
          </p>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;"><strong>What:</strong> ${escapeHtml(opts.title)}</p>
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;"><strong>When:</strong> ${escapeHtml(opts.when)}</p>
            ${locationBlock}
          </div>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">Automated message from Scholera.</p>
        </div>
      `,
    })
    if (error) {
      logger.error('sendBookingConfirmed: Failed', error, { to })
      return false
    }
    logger.info('sendBookingConfirmed: Sent', { to })
    return true
  } catch (error) {
    logger.error('sendBookingConfirmed: Exception', error, { to })
    return false
  }
}

/**
 * Notifies a student that their office-hours booking was cancelled by the professor.
 * Best-effort.
 *
 * @param to - Student's email
 * @param name - Student's name
 * @param opts.title - Booking title
 * @param opts.when - Human-readable date + time
 * @param opts.reason - Optional cancellation reason
 */
export async function sendBookingCancelled(
  to: string,
  name: string,
  opts: { title: string; when: string; reason?: string | null }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendBookingCancelled: Skipped — no email client configured', { to })
    return false
  }

  const reasonBlock = opts.reason
    ? `<p style="color: #374151; font-size: 14px; margin: 8px 0 0 0;"><strong>Reason:</strong> ${escapeHtml(opts.reason)}</p>`
    : ''
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Booking cancelled — ${opts.title}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 22px; margin-bottom: 8px;">Booking cancelled</h1>
          <p style="color: #6b7280; font-size: 15px; margin-bottom: 24px;">
            Hi ${escapeHtml(name)}, your professor cancelled the following office-hours booking.
          </p>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;"><strong>What:</strong> ${escapeHtml(opts.title)}</p>
            <p style="color: #374151; font-size: 14px; margin: 0;"><strong>When:</strong> ${escapeHtml(opts.when)}</p>
            ${reasonBlock}
          </div>
          <p style="color: #6b7280; font-size: 14px;">You can book another slot from your office-hours page.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">Automated message from Scholera.</p>
        </div>
      `,
    })
    if (error) {
      logger.error('sendBookingCancelled: Failed', error, { to })
      return false
    }
    logger.info('sendBookingCancelled: Sent', { to })
    return true
  } catch (error) {
    logger.error('sendBookingCancelled: Exception', error, { to })
    return false
  }
}

/**
 * Notifies a student that a professor requested changes / a resubmission on their
 * assignment submission — a time-sensitive "must" channel. Best-effort.
 *
 * @param to - Student's email
 * @param name - Student's name
 * @param opts.assignmentTitle - The assignment title
 * @param opts.feedback - Optional professor feedback
 * @param opts.link - Path or absolute URL to the assignment
 */
export async function sendResubmissionRequested(
  to: string,
  name: string,
  opts: { assignmentTitle: string; feedback?: string | null; link: string }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendResubmissionRequested: Skipped — no email client configured', { to })
    return false
  }

  const url = opts.link.startsWith('http') ? opts.link : `${getSiteUrl()}${opts.link}`
  const feedbackBlock = opts.feedback
    ? `<div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;"><strong>Feedback:</strong></p>
            <p style="color: #6b7280; font-size: 14px; margin: 0; white-space: pre-wrap;">${escapeHtml(opts.feedback)}</p>
          </div>`
    : ''
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Resubmission requested — ${opts.assignmentTitle}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 22px; margin-bottom: 8px;">Changes requested</h1>
          <p style="color: #6b7280; font-size: 15px; margin-bottom: 24px;">
            Hi ${escapeHtml(name)}, your professor asked for changes on <strong>${escapeHtml(opts.assignmentTitle)}</strong>. Please review the feedback and resubmit.
          </p>
          ${feedbackBlock}
          <div style="margin-bottom: 20px;">
            <a href="${url}" style="display: inline-block; background: #111827; color: #ffffff; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px; text-decoration: none;">View assignment</a>
          </div>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">Automated message from Scholera.</p>
        </div>
      `,
    })
    if (error) {
      logger.error('sendResubmissionRequested: Failed', error, { to })
      return false
    }
    logger.info('sendResubmissionRequested: Sent', { to })
    return true
  } catch (error) {
    logger.error('sendResubmissionRequested: Exception', error, { to })
    return false
  }
}

/** One line in the daily digest email. */
export interface DigestItem {
  title: string
  linkUrl: string | null
  courseLabel: string | null
}

/**
 * Sends the daily notification digest — the past day's unread items, grouped by
 * course. Best-effort; returns false if no email client is configured or the send
 * fails. Called by the notifications cron once per student per day (see
 * src/lib/notifications/digest.ts).
 *
 * @param to - Student's email
 * @param name - Student's name
 * @param opts.items - Unread digest-eligible items (newest first)
 * @param opts.date - The digest date (institution-local YYYY-MM-DD), for the log context
 */
export async function sendDailyDigest(
  to: string,
  name: string,
  opts: { items: DigestItem[]; date: string; ctaPath?: string; frequency?: 'daily' | 'weekly' | 'biweekly' },
): Promise<boolean> {
  // Cadence word for the subject + eyebrow ("Your Scholera weekly digest").
  const freqWord = opts.frequency === 'weekly' ? 'weekly' : opts.frequency === 'biweekly' ? 'biweekly' : 'daily'
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendDailyDigest: Skipped — no email client configured', { to })
    return false
  }
  if (opts.items.length === 0) return false

  const base = getSiteUrl()
  const logo = getLogoAttachment()
  const logoImg = logoImgTag()
  // Group by course so the digest reads "CS201: …, CS101: …" rather than a flat list.
  const groups = new Map<string, DigestItem[]>()
  for (const it of opts.items) {
    const key = it.courseLabel || 'Other'
    const arr = groups.get(key) ?? []
    arr.push(it)
    groups.set(key, arr)
  }
  const sections = Array.from(groups.entries())
    .map(([course, items]) => {
      const lis = items
        .map((it) => {
          const url = it.linkUrl
            ? it.linkUrl.startsWith('http')
              ? it.linkUrl
              : `${base}${it.linkUrl}`
            : null
          const title = escapeHtml(it.title)
          return url
            ? `<li style="margin: 0 0 6px 0;"><a href="${escapeHtml(url)}" style="color: #276ee1; font-weight: 600;">${title}</a></li>`
            : `<li style="margin: 0 0 6px 0; color: #111827;">${title}</li>`
        })
        .join('')
      return `
          <div style="margin-bottom: 20px;">
            <p style="color: #276ee1; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 6px 0;">${escapeHtml(course)}</p>
            <ul style="margin: 0; padding-left: 18px; font-size: 15px; line-height: 1.5;">${lis}</ul>
          </div>`
    })
    .join('')

  const count = opts.items.length
  const summary = `${count} update${count === 1 ? '' : 's'}`
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      ...(logo ? { attachments: [logo] } : {}),
      subject: `Your Scholera ${freqWord} digest — ${summary}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f5f7; padding: 24px 12px;">
          <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border: 1px solid #ececf0; border-radius: 16px; overflow: hidden;">
            <div style="height: 6px; background: linear-gradient(90deg, #276ee1, #5590f3);"></div>
            <div style="padding: 28px 30px 28px;">
              <div style="margin: 0 0 16px;">
                ${logoImg}
                <span style="vertical-align: middle; margin-left: 10px; font-size: 22px; font-weight: 800; letter-spacing: -0.01em; color: #14171f;">Scholera</span>
              </div>
              <p style="margin: 0 0 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #276ee1;">Your ${freqWord} digest</p>
              <h1 style="margin: 0 0 6px; color: #14171f; font-size: 24px; font-weight: 800;">Good morning${name ? `, ${escapeHtml(name)}` : ''} 👋</h1>
              <p style="margin: 0 0 24px; color: #6b7280; font-size: 15px;">Here's what happened in your courses — ${summary} you haven't seen yet.</p>
              ${sections}
              <div style="margin: 8px 0 4px;">
                <a href="${base}${opts.ctaPath ?? '/student/courses'}" style="display: inline-block; background: #276ee1; color: #ffffff; font-size: 14px; font-weight: 700; padding: 12px 26px; border-radius: 10px; text-decoration: none;">Open Scholera &rarr;</a>
              </div>
            </div>
            <div style="padding: 16px 30px; background: #fafafb; border-top: 1px solid #ececf0;">
              <p style="margin: 0; color: #9aa0ab; font-size: 12px;">You're receiving this because you have unread updates in Scholera. Automated ${freqWord} digest.</p>
            </div>
          </div>
        </div>
      `,
    })
    if (error) {
      logger.error('sendDailyDigest: Failed', error, { to })
      return false
    }
    logger.info('sendDailyDigest: Sent', { to, items: count })
    return true
  } catch (error) {
    logger.error('sendDailyDigest: Exception', error, { to })
    return false
  }
}

/**
 * Sends a single re-engagement nudge to a dormant student — a witty, personalised
 * one-liner with a way back in. Best-effort; returns false if no email client is
 * configured or the send fails. Called by the notifications cron (see
 * src/lib/notifications/re-engagement.ts). The copy (title/body) is generated upstream
 * from the student's OWN data only (no grades, no other students' data), so this helper
 * just renders it — the witty title doubles as the subject line, since that's what earns
 * the open.
 */
export async function sendReengagementEmail(
  to: string,
  opts: { title: string; body: string },
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendReengagementEmail: Skipped — no email client configured', { to })
    return false
  }
  const base = getSiteUrl()
  const logo = getLogoAttachment()
  const logoImg = logoImgTag()
  const title = escapeHtml(opts.title)
  const body = escapeHtml(opts.body)
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      ...(logo ? { attachments: [logo] } : {}),
      subject: opts.title,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f5f7; padding: 24px 12px;">
          <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #ececf0; border-radius: 16px; overflow: hidden;">
            <div style="height: 6px; background: linear-gradient(90deg, #276ee1, #5590f3);"></div>
            <div style="padding: 28px 30px 30px;">
              <div style="margin: 0 0 16px;">
                ${logoImg}
                <span style="vertical-align: middle; margin-left: 10px; font-size: 22px; font-weight: 800; letter-spacing: -0.01em; color: #14171f;">Scholera</span>
              </div>
              <p style="margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #276ee1;">a nudge for you</p>
              <h1 style="margin: 0 0 12px; font-size: 27px; line-height: 1.2; font-weight: 800; color: #14171f;">${title}</h1>
              <p style="margin: 0 0 28px; font-size: 16px; line-height: 1.55; color: #3f4550;">${body}</p>
              <a href="${base}/student/courses" style="display: inline-block; background: #276ee1; color: #ffffff; font-size: 15px; font-weight: 700; padding: 13px 28px; border-radius: 10px; text-decoration: none;">Jump back in &rarr;</a>
            </div>
            <div style="padding: 16px 30px; background: #fafafb; border-top: 1px solid #ececf0;">
              <p style="margin: 0; color: #9aa0ab; font-size: 12px; line-height: 1.5;">You're getting this because it's been a while since you visited Scholera.</p>
            </div>
          </div>
        </div>
      `,
    })
    if (error) {
      logger.error('sendReengagementEmail: Failed', error, { to })
      return false
    }
    logger.info('sendReengagementEmail: Sent', { to })
    return true
  } catch (error) {
    logger.error('sendReengagementEmail: Exception', error, { to })
    return false
  }
}

/**
 * Receipt to the institution admin who just asked Scholera for a feature.
 *
 * Deliberately says nothing about when we will answer. A promise we cannot keep
 * is worse than no promise, and the honest content is "we have it, here is what
 * you asked for". Best-effort like every send in this file.
 */
export async function sendFeatureRequestReceived(
  to: string,
  adminName: string,
  opts: { featureLabel: string; message?: string | null }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendFeatureRequestReceived: Skipped — no email client configured', { to })
    return false
  }

  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Scholera — we received your request for ${opts.featureLabel}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 22px; margin-bottom: 8px;">Request received</h1>
          <p style="color: #6b7280; font-size: 15px; margin-bottom: 24px;">
            Hi ${escapeHtml(adminName)}, we have your request to add <strong>${escapeHtml(opts.featureLabel)}</strong> to your institution's plan. Someone at Scholera will review it and you will hear back here.
          </p>
          ${
            opts.message
              ? `<div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;"><strong>What you told us:</strong></p>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">${escapeHtml(opts.message)}</p>
          </div>`
              : ''
          }
          <p style="color: #6b7280; font-size: 14px;">
            Nothing changes for your courses in the meantime, and you can withdraw the request from your Settings page.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">Automated message from Scholera.</p>
        </div>
      `,
    })
    if (error) {
      logger.error('sendFeatureRequestReceived: Failed', error, { to })
      return false
    }
    logger.info('sendFeatureRequestReceived: Sent', { to })
    return true
  } catch (error) {
    logger.error('sendFeatureRequestReceived: Exception', error, { to })
    return false
  }
}

/**
 * Tells the institution their plan gained a feature. Leads with what they can
 * now do rather than with the word "approved", because the useful information
 * is that professors can start using it today.
 */
export async function sendFeatureGranted(
  to: string,
  adminName: string,
  opts: { featureLabel: string; note?: string | null }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendFeatureGranted: Skipped — no email client configured', { to })
    return false
  }

  try {
    const settingsUrl = `${getSiteUrl()}/admin/settings`
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Scholera — ${opts.featureLabel} is now available`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 22px; margin-bottom: 8px;">${escapeHtml(opts.featureLabel)} is now available</h1>
          <p style="color: #6b7280; font-size: 15px; margin-bottom: 24px;">
            Hi ${escapeHtml(adminName)}, <strong>${escapeHtml(opts.featureLabel)}</strong> has been switched on for your institution. Professors can start using it in any course straight away — there is nothing for you to set up.
          </p>
          ${
            opts.note
              ? `<div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;"><strong>Note from Scholera:</strong></p>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">${escapeHtml(opts.note)}</p>
          </div>`
              : ''
          }
          <a href="${settingsUrl}" style="display: inline-block; background: #111827; color: #ffffff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-size: 14px;">View your plan</a>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">Automated message from Scholera.</p>
        </div>
      `,
    })
    if (error) {
      logger.error('sendFeatureGranted: Failed', error, { to })
      return false
    }
    logger.info('sendFeatureGranted: Sent', { to })
    return true
  } catch (error) {
    logger.error('sendFeatureGranted: Exception', error, { to })
    return false
  }
}

/**
 * Tells the requester their ask was turned down, and why. The reason is
 * mandatory upstream: a school that hears "no" with no explanation cannot tell
 * whether asking again would ever work.
 */
export async function sendFeatureRequestDeclined(
  to: string,
  adminName: string,
  opts: { featureLabel: string; reason: string }
): Promise<boolean> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('sendFeatureRequestDeclined: Skipped — no email client configured', { to })
    return false
  }

  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Scholera — about your request for ${opts.featureLabel}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827; font-size: 22px; margin-bottom: 8px;">Request not approved</h1>
          <p style="color: #6b7280; font-size: 15px; margin-bottom: 24px;">
            Hi ${escapeHtml(adminName)}, we could not add <strong>${escapeHtml(opts.featureLabel)}</strong> to your plan right now.
          </p>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <p style="color: #374151; font-size: 14px; margin: 0 0 8px 0;"><strong>Why:</strong></p>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">${escapeHtml(opts.reason)}</p>
          </div>
          <p style="color: #6b7280; font-size: 14px;">
            Nothing about your existing courses has changed. If circumstances change you can ask again from your Settings page.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">Automated message from Scholera.</p>
        </div>
      `,
    })
    if (error) {
      logger.error('sendFeatureRequestDeclined: Failed', error, { to })
      return false
    }
    logger.info('sendFeatureRequestDeclined: Sent', { to })
    return true
  } catch (error) {
    logger.error('sendFeatureRequestDeclined: Exception', error, { to })
    return false
  }
}
