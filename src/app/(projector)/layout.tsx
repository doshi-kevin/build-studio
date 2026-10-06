// Projector route group — a chrome-less layout (no dashboard header/sidebar)
// for the Live Classroom Projector View. It's a SIBLING of the (dashboard)
// group, so nested routes don't inherit the dashboard chrome.
//
// RealtimeAuthMount pushes the Supabase JWT into the realtime client so the
// private room channel authorizes. Auth redirects are handled in middleware.
//
// IdleTimeout is here too: the wall never gets input, but while the presenter's
// tab is live it keeps the shared activity stamp fresh. Once class is over and
// nobody touches anything for 60 minutes, the projector signs out with it
// instead of holding the professor's session open on a classroom PC. Silent:
// the warning shows on the presenter's screen, not on the wall.

import { IdleTimeout } from '@/components/shared/IdleTimeout'
import { RealtimeAuthMount } from '@/lib/supabase/realtime-auth'

export default function ProjectorLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    /* `lc-projector` here as well as on the view itself: the layout paints the
       ground behind every projector route (including the 404 boundary), so it
       must resolve `--background` to the same black rather than the app's
       near-white page colour. Deliberately NOT `lc-stage` — the wall is its own
       dark scope and does not follow the presenter into the light. See
       globals.css. */
    <div className="lc-projector h-dvh w-screen overflow-hidden bg-background">
      {children}
      <RealtimeAuthMount />
      <IdleTimeout silent />
    </div>
  )
}
