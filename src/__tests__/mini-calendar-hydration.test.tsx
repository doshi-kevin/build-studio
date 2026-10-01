/**
 * #765: MiniCalendar must not derive a date during the server pass.
 *
 * It is a client component, but client components are still SERVER-rendered in the App Router, so
 * `useState(() => new Date())` and `useMemo(() => new Date(), [])` evaluated once in the server's
 * timezone and again in the browser's. When the two landed on different calendar dates the markup
 * disagreed, React logged error #418, and React does NOT repair a mismatch of this kind: the student
 * was left looking at the SERVER's date on the surface they use to plan their week.
 *
 * The test that matters is the SERVER pass, because that is the half that was wrong. Rendering to
 * static markup with the TZ forced to two zones on opposite sides of the date line must produce
 * byte-identical output. If any date leaks into the server render, the two differ and this fails.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MiniCalendar } from '@/components/student/dashboard/MiniCalendar'
import { StudentCalendar } from '@/components/student/calendar/StudentCalendar'

const originalTZ = process.env.TZ

afterEach(() => {
  process.env.TZ = originalTZ
})

/** Server-render the component with the process timezone forced. */
function markupInZone(tz: string): string {
  process.env.TZ = tz
  return renderToStaticMarkup(<MiniCalendar events={[]} />)
}

describe('#765: the server pass carries no date', () => {
  it('renders identically in Tokyo and Los Angeles', () => {
    /* These two are ~17 hours apart, so for most of any given day they are on DIFFERENT calendar
       dates. That is precisely the window in which the old code produced divergent markup. */
    const tokyo = markupInZone('Asia/Tokyo')
    const la = markupInZone('America/Los_Angeles')

    expect(tokyo).toBe(la)
  })

  it('reserves a box rather than rendering nothing', () => {
    /* Returning null on the server would collapse the card and the page would jump when the real
       calendar mounts. The skeleton has to occupy the same container. */
    const html = markupInZone('UTC')

    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('rounded-2xl')
    expect(html).toContain('border-border')
  })

  it('leaks no day number or month name into the server pass', () => {
    /* The sharpest form of the assertion: a month name or a 4-digit year in the server markup means
       a date was derived during render, which is the bug regardless of whether the zones happen to
       agree at the moment the suite runs. */
    const html = markupInZone('Asia/Tokyo')

    expect(html).not.toMatch(/January|February|March|April|May|June|July|August|September|October|November|December/)
    expect(html).not.toMatch(/\b20\d{2}\b/)
  })
})

describe('#765: the calendar ROUTE carries no date either', () => {
  /* The issue names MiniCalendar, but /student/calendar is where QA actually observed React error
     #418, and StudentCalendar has the identical pattern plus two descendants that derive dates
     during render (StudentMonthView's `today`, StudentTimeGrid's `now`). Fixing only the dashboard
     would have left the reported error exactly where it was reported. */
  function routeMarkup(tz: string): string {
    process.env.TZ = tz
    return renderToStaticMarkup(<StudentCalendar events={[]} />)
  }

  it('renders identically in Tokyo and Los Angeles', () => {
    expect(routeMarkup('Asia/Tokyo')).toBe(routeMarkup('America/Los_Angeles'))
  })

  it('leaks no month name or year into the server pass', () => {
    const html = routeMarkup('Asia/Tokyo')
    expect(html).not.toMatch(/January|February|March|April|May|June|July|August|September|October|November|December/)
    expect(html).not.toMatch(/\b20\d{2}\b/)
  })
})
