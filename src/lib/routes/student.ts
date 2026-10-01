/**
 * Every student destination Athena can drive to, in one place — design doc §13.3.
 *
 * The point is not tidiness. Athena's tools hand back real hrefs built from ids
 * the server resolved; the model never constructs a URL and never supplies an
 * id, which removes a whole class of hallucinated link. The human UI uses the
 * same map, so the two can't drift.
 *
 * Pure string building, no imports — safe on both sides of the server/client
 * line.
 */

export const studentRoute = {
  /** The roadmap with one node's modal open. The roadmap reads `?node=` after
   *  mount, so this works as a client push into a page already rendered. */
  roadmapNode: (sectionId: string, nodeKey: string) =>
    `/student/courses/${sectionId}/roadmap?node=${encodeURIComponent(nodeKey)}`,

  /** The roadmap with a saved knowledge map lit as a highlight lens. The plain
   *  artifact row id goes in the URL — short, harmless, deep-linkable and
   *  refresh-proof (§14.4/§14.8) — and the roadmap loads the path from that row
   *  rather than from anything the model wrote. Same-path with the node deep
   *  link, so pushing it from the roadmap itself is a query-only change. */
  roadmapPath: (sectionId: string, artifactId: string) =>
    `/student/courses/${sectionId}/roadmap?path=${encodeURIComponent(artifactId)}`,

  /** The challenge board with one card scrolled to and highlighted. The id goes
   *  in the URL rather than the pre-fill handoff because it is short and
   *  harmless — and a URL is better for it: deep-linkable and refresh-proof
   *  (§14.8). */
  challenge: (sectionId: string, challengeId: string) =>
    `/student/courses/${sectionId}/challenges?challenge=${encodeURIComponent(challengeId)}`,

  /** A live classroom the student is (or is about to be) sitting in. The
   *  drafted question rides the pre-fill handoff, not this URL. */
  liveRoom: (sectionId: string, roomId: string) =>
    `/student/courses/${sectionId}/live-classroom/${roomId}`,

  /** The booking page, opened on the right professor and the next day they
   *  actually hold office hours. Ids and a date in the URL, same rule as the
   *  challenge board; the drafted note rides the pre-fill handoff because it is
   *  prose (§14.4). This route is OUTSIDE the course segment, which is why the
   *  shell mounts at /student/layout.tsx (§14.7 D1). */
  officeHours: (professorId: string, date: string) =>
    `/student/office-hours?professor=${encodeURIComponent(professorId)}&date=${encodeURIComponent(date)}`,
} as const
