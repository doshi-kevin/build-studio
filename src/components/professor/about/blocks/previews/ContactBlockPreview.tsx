// Contact & Office Hours — student-facing render. Two-column card with the
// instructor's identity on the left and reach-me details on the right.
// Pure monochrome to match the editorial theme; only renders fields the
// professor actually filled in.

'use client'

import { Mail, MapPin, Clock, Video, Timer } from 'lucide-react'
import type { ContactBlock } from '@/lib/validations/course-about'

interface Props {
  block: ContactBlock
}

// The virtual-office field is a free string that renders as an href to every
// enrolled student, and (unlike the other fields) it is now Athena-writable. React
// neutralizes javascript:/data: as script, so the residual is a phishing
// destination — gate the href to http(s) so only a real link becomes clickable; a
// non-URL value still shows as text. Defense-in-depth over the prompt's
// never-construct-a-URL rule.
const safeHttpUrl = (v: string): string | undefined =>
  /^https?:\/\//i.test(v.trim()) ? v.trim() : undefined

export function ContactBlockPreview({ block }: Props) {
  const d = block.data
  const hasIdentity = d.name || d.title
  const zoomHref = d.zoomUrl ? safeHttpUrl(d.zoomUrl) : undefined
  const rows = [
    { icon: Mail, label: 'Email', value: d.email, href: d.email ? `mailto:${d.email}` : undefined },
    { icon: MapPin, label: 'Office', value: d.officeLocation },
    { icon: Clock, label: 'Office hours', value: d.officeHours },
    { icon: Video, label: 'Virtual office', value: d.zoomUrl, href: zoomHref, isLink: true },
    { icon: Timer, label: 'Response time', value: d.responseTime },
  ].filter((r) => r.value)

  if (!hasIdentity && rows.length === 0) return null

  return (
    <section className="rounded-3xl border border-border bg-card overflow-hidden">
      <div className="px-6 sm:px-8 py-6 grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-6 sm:gap-10">
        {hasIdentity && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
              Instructor
            </p>
            {d.name && (
              <p className="font-[family-name:var(--font-instrument-serif)] text-2xl text-foreground leading-tight">
                {d.name}
              </p>
            )}
            {d.title && <p className="text-sm text-muted-foreground">{d.title}</p>}
          </div>
        )}

        {rows.length > 0 && (
          <dl className="space-y-3">
            {rows.map((row) => {
              const Icon = row.icon
              return (
                <div key={row.label} className="flex items-start gap-3">
                  <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <dt className="text-[10px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
                      {row.label}
                    </dt>
                    <dd className="text-sm text-foreground mt-0.5 break-words">
                      {row.href ? (
                        <a
                          href={row.href}
                          target={row.isLink ? '_blank' : undefined}
                          rel={row.isLink ? 'noopener noreferrer' : undefined}
                          className="underline underline-offset-2 hover:text-muted-foreground transition-colors"
                        >
                          {row.value}
                        </a>
                      ) : (
                        row.value
                      )}
                    </dd>
                  </div>
                </div>
              )
            })}
          </dl>
        )}
      </div>
    </section>
  )
}
