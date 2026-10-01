// Projector route group — a chrome-less layout (no dashboard header/sidebar)
// for the Live Classroom Projector View. It's a SIBLING of the (dashboard)
// group, so nested routes don't inherit the dashboard chrome.
//
// RealtimeAuthMount pushes the Supabase JWT into the realtime client so the
// private room channel authorizes. Auth redirects are handled in middleware.

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
    </div>
  )
}
