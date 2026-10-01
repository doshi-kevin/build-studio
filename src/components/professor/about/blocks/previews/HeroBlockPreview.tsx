// Hero block — student-facing render. Editorial monochrome treatment:
// the banner photo (the professor's upload, or the bundled default when they
// haven't added one) gets a fixed two-layer scrim so the white title is
// legible on any image. No solid black panels — that fights the cream theme.

'use client'

import { ExternalLink, Calendar, Award, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { HeroBlock } from '@/lib/validations/course-about'
import { parseVideoUrl } from '../../block-editor'

/** Shipped static asset shown until the professor uploads their own banner. */
export const DEFAULT_BANNER_SRC = '/course-banner-default.jpg'

interface Props {
  block: HeroBlock
}

export function HeroBlockPreview({ block }: Props) {
  const { data } = block
  const hasContent = data.title || data.subtitle
  if (!hasContent && !data.bannerSrc) return null

  const videoInfo = parseVideoUrl(data.introVideoUrl)
  const hasMeta = data.instructor || data.semester || data.credits
  const hasCta = data.ctaText && data.ctaUrl

  return (
    <section className="rounded-3xl overflow-hidden border border-border bg-card">
      {/* Fixed two-layer scrim that guarantees WCAG-safe legibility on any
         photo — a baseline 45% darkening across the whole image, plus a 70%
         bottom gradient where the title sits (~84% cumulative behind the
         text). Fixed by design; the old per-course opacity slider allowed
         illegible combinations. */}
      <div className="relative">
        {/* The shared default photo is decorative chrome — empty alt so screen
           readers skip straight to the real course title below. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={data.bannerSrc || DEFAULT_BANNER_SRC}
          alt={data.bannerSrc ? data.bannerAlt : ''}
          className="w-full h-72 sm:h-80 object-cover"
        />
        <div className="absolute inset-0 bg-black/45" />
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(to bottom, transparent 30%, rgba(0,0,0,0.7) 100%)' }}
        />
        <div className="absolute inset-0 flex flex-col justify-end p-8 text-white">
          {/* Subtitle carries drop-shadow too: it sits higher in the gradient
             than the title, where the scrim alone can dip below AA on a
             bright photo. */}
          {data.subtitle && (
            <p className="text-[11px] uppercase tracking-[0.2em] font-semibold opacity-95 mb-2 drop-shadow-md">
              {data.subtitle}
            </p>
          )}
          {data.title && (
            <h1 className="font-[family-name:var(--font-instrument-serif)] text-4xl sm:text-5xl leading-[1.05] drop-shadow-md">
              {data.title}
            </h1>
          )}
        </div>
      </div>

      {/* Metadata strip — quiet muted band, monochrome icons */}
      {(hasMeta || hasCta) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-8 sm:px-12 py-4 border-t border-border bg-muted/30">
          {data.instructor && (
            <span className="flex items-center gap-1.5 text-sm text-foreground">
              <User className="h-3.5 w-3.5 text-muted-foreground" />
              {data.instructor}
            </span>
          )}
          {data.semester && (
            <span className="flex items-center gap-1.5 text-sm text-foreground">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              {data.semester}
            </span>
          )}
          {data.credits && (
            <span className="flex items-center gap-1.5 text-sm text-foreground">
              <Award className="h-3.5 w-3.5 text-muted-foreground" />
              {data.credits}
            </span>
          )}
          {hasCta && (
            <a href={data.ctaUrl} target="_blank" rel="noopener noreferrer" className="ml-auto">
              <Button size="sm" className="rounded-full">
                {data.ctaText}
                <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            </a>
          )}
        </div>
      )}

      {videoInfo.embedUrl && (
        <div className="p-8 sm:p-12 border-t border-border">
          <div className="aspect-video rounded-2xl overflow-hidden bg-muted max-w-2xl">
            <iframe
              src={videoInfo.embedUrl}
              title="Course intro"
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>
      )}
    </section>
  )
}
