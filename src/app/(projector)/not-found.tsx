/**
 * Projector not-found boundary — catches notFound() from the Live Classroom
 * Projector View (a stale room URL, an ended session, a room belonging to
 * another professor). This surface is displayed on a lecture-hall screen, so a
 * bare Next.js 404 here is the most publicly visible failure in the app.
 *
 * Deliberately NOT the shared DeadEnd: the projector has a zero-controls spec
 * (no buttons, no nav — the professor drives everything from their dashboard),
 * so a CTA here would be a non-functional affordance shown to a room full of
 * students. It reuses ProjectorMessage, the projector's own passive state
 * component, matching the type scale and black canvas of every other projector
 * state. The professor's "exit" is closing the window.
 */

import { ProjectorMessage } from '@/components/professor/live-classroom/ProjectorView'

export default function ProjectorNotFound() {
  return (
    <ProjectorMessage
      title="This session isn't available"
      body="It may have ended or been removed. Reopen the projector view from your live classroom."
    />
  )
}
