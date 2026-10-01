/**
 * Slack notifier — posts user feedback submissions to the team's Slack
 * workspace via an incoming webhook (target channel is configured per-webhook
 * in Slack itself, e.g. #issues).
 *
 * Required env: SLACK_FEEDBACK_WEBHOOK_URL. When unset, postFeedbackToSlack
 * silently no-ops with a single warn — feedback submission is never blocked.
 *
 * All errors are caught and logged internally; this module never throws into
 * the caller. The intended call-site pattern is to invoke postFeedbackToSlack
 * from inside Next.js's `after()` so the HTTP response returns to the user
 * before the Slack POST runs.
 *
 * Layout: bug reports get an extra "fields" block with browser/OS, page title,
 * feature, and section ID — context the team needs to triage. All categories
 * get a colored sidebar via Slack's attachments API for visual scannability.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { getSiteUrl } from '@/lib/site-url'
import type { FeedbackCategory, PageContext } from '@/lib/validations/feedback'

const RATING_EMOJI: Record<1 | 2 | 3, string> = {
  1: ':disappointed:',
  2: ':neutral_face:',
  3: ':smile:',
}

const RATING_LABEL: Record<1 | 2 | 3, string> = {
  1: 'Bad',
  2: 'Okay',
  3: 'Great',
}

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: ':bug: Bug Report',
  feature_request: ':sparkles: Feature Request',
  content_issue: ':books: Content Issue',
  ux: ':art: UX / Usability',
  general: ':speech_balloon: General',
}

// Sidebar color per category — bugs are red so they stand out in the channel
// feed; less urgent categories use cooler hues.
const CATEGORY_COLOR: Record<FeedbackCategory, string> = {
  bug: '#dc2626',
  content_issue: '#d97706',
  ux: '#7c3aed',
  feature_request: '#0891b2',
  general: '#6b7280',
}

// Slack section block plain-text limit is 3000 chars; leave headroom for safety.
const MESSAGE_TRUNCATE_AT = 2900

export interface FeedbackSlackPayload {
  feedbackId: string
  userId: string
  userRole: 'student' | 'professor'
  rating: 1 | 2 | 3
  category: FeedbackCategory
  message: string | null
  pageUrl: string
  pageContext: PageContext | null
  createdAt: string
}

interface ResolvedUser {
  displayName: string
  email: string
}

async function resolveUser(userId: string): Promise<ResolvedUser> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data, error } = await adminDb
      .from('profiles')
      .select('email, name, first_name, last_name')
      .eq('id', userId)
      .maybeSingle()

    if (error || !data) {
      return { displayName: 'Unknown User', email: 'unknown@scholera-inc.com' }
    }

    const composed =
      data.name?.trim() ||
      [data.first_name, data.last_name].filter(Boolean).join(' ').trim() ||
      data.email ||
      'Unknown User'

    return { displayName: composed, email: data.email || 'unknown@scholera-inc.com' }
  } catch (err) {
    logger.warn('slack.resolveUser: lookup failed', { userId, err: String(err) })
    return { displayName: 'Unknown User', email: 'unknown@scholera-inc.com' }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

/**
 * Best-effort userAgent → human-readable string. Pure regex so we don't
 * pull in a dep just for triage display. Returns "Unknown" on no match.
 */
export function summarizeUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown'

  const browser =
    /Edg\/([\d.]+)/.exec(ua)?.[1] && `Edge ${/Edg\/(\d+)/.exec(ua)?.[1]}` ||
    /Chrome\/(\d+)/.exec(ua)?.[1] && `Chrome ${/Chrome\/(\d+)/.exec(ua)?.[1]}` ||
    /Firefox\/(\d+)/.exec(ua)?.[1] && `Firefox ${/Firefox\/(\d+)/.exec(ua)?.[1]}` ||
    /Version\/(\d+).*Safari/.exec(ua)?.[1] && `Safari ${/Version\/(\d+)/.exec(ua)?.[1]}` ||
    'Unknown browser'

  let os = 'Unknown OS'
  if (/iPhone|iPad/.test(ua)) {
    const v = /OS (\d+_\d+)/.exec(ua)?.[1]?.replace('_', '.')
    os = v ? `iOS ${v}` : 'iOS'
  } else if (/Android/.test(ua)) {
    os = `Android ${/Android (\d+)/.exec(ua)?.[1] || ''}`.trim()
  } else if (/Mac OS X/.test(ua)) {
    const v = /Mac OS X (\d+[._]\d+)/.exec(ua)?.[1]?.replace('_', '.')
    os = v ? `macOS ${v}` : 'macOS'
  } else if (/Windows NT/.test(ua)) {
    const v = /Windows NT ([\d.]+)/.exec(ua)?.[1]
    const winMap: Record<string, string> = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' }
    os = `Windows ${(v && winMap[v]) || v || ''}`.trim()
  } else if (/Linux/.test(ua)) {
    os = 'Linux'
  }

  return `${browser} on ${os}`
}

export function buildFeedbackBlocks(
  payload: FeedbackSlackPayload,
  user: ResolvedUser,
  siteUrl: string,
) {
  const ratingEmoji = RATING_EMOJI[payload.rating]
  const ratingLabel = RATING_LABEL[payload.rating]
  const categoryLabel = CATEGORY_LABEL[payload.category]
  // Compose the section text, then truncate the *final* string. Doing it in
  // this order means heavy newline content (each '\n' becomes '\n>') can't
  // push us past Slack's 3000-char section limit.
  const rawMessage = payload.message
    ? payload.message.replace(/\n/g, '\n>')
    : '_(no message provided)_'
  const sectionText = truncate(`>*Feedback:*\n>${rawMessage}`, MESSAGE_TRUNCATE_AT)

  const cleanSiteUrl = siteUrl.replace(/\/$/, '')
  const fullPageUrl = payload.pageUrl.startsWith('http')
    ? payload.pageUrl
    : `${cleanSiteUrl}${payload.pageUrl}`
  const adminUrl = `${cleanSiteUrl}/admin/feedback`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `New feedback: ${ratingLabel} ${payload.rating}/3`,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${ratingEmoji} *${categoryLabel}* · from *${user.displayName}* (${user.email}) · _${payload.userRole}_`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: sectionText,
      },
    },
  ]

  // Bug reports: include the diagnostics fields the team needs to triage
  // without having to ping the user back. Other categories don't get this
  // — keeps the channel feed scannable for non-bug feedback.
  if (payload.category === 'bug' && payload.pageContext) {
    const ctx = payload.pageContext
    const fields = [
      { label: 'Page', value: ctx.pageTitle?.trim() || '_(none)_' },
      { label: 'Feature', value: ctx.featureName ? `\`${ctx.featureName}\`` : '_(top-level)_' },
      { label: 'Section', value: ctx.sectionId ? `\`${ctx.sectionId}\`` : '_(none)_' },
      { label: 'Browser / OS', value: summarizeUserAgent(ctx.browser) },
    ]
    blocks.push({
      type: 'section',
      fields: fields.map((f) => ({
        type: 'mrkdwn',
        text: `*${f.label}*\n${f.value}`,
      })),
    })
  }

  blocks.push(
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:link: <${fullPageUrl}|${payload.pageUrl}> · :clock1: <!date^${Math.floor(new Date(payload.createdAt).getTime() / 1000)}^{date_short_pretty} {time}|${payload.createdAt}> · \`${payload.feedbackId}\``,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in admin dashboard', emoji: true },
          url: adminUrl,
        },
      ],
    },
  )

  return blocks
}

/**
 * Posts a feedback submission to the configured Slack webhook.
 *
 * Fire-and-forget by design: never throws, never blocks. Returns true on a
 * successful 2xx, false on any failure (including missing config).
 */
export async function postFeedbackToSlack(
  payload: FeedbackSlackPayload,
): Promise<boolean> {
  const webhookUrl = process.env.SLACK_FEEDBACK_WEBHOOK_URL
  if (!webhookUrl) {
    logger.warn('Slack: SLACK_FEEDBACK_WEBHOOK_URL not configured — skipping Slack notification', {
      feedbackId: payload.feedbackId,
    })
    return false
  }

  try {
    const user = await resolveUser(payload.userId)
    const siteUrl = getSiteUrl()
    const blocks = buildFeedbackBlocks(payload, user, siteUrl)
    const color = CATEGORY_COLOR[payload.category]

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `New feedback from ${user.displayName}: ${RATING_LABEL[payload.rating]} ${payload.rating}/3`,
        // attachments[].color renders as a colored sidebar to the left of the
        // message — Slack's standard pattern for category/severity coding.
        attachments: [{ color, blocks }],
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logger.error('Slack: Webhook POST failed', null, {
        feedbackId: payload.feedbackId,
        status: res.status,
        body: body.slice(0, 500),
      })
      return false
    }

    logger.info('Slack: Feedback notification posted', {
      feedbackId: payload.feedbackId,
      category: payload.category,
    })
    return true
  } catch (err) {
    logger.error('Slack: Webhook POST threw', err, { feedbackId: payload.feedbackId })
    return false
  }
}
