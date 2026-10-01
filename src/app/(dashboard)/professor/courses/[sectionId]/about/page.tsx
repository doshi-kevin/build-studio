/**
 * About route redirect — the About page now lives at the course root.
 * This redirect ensures old bookmarks and cached links still work.
 */

import { redirect } from 'next/navigation'

interface AboutPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function AboutRedirectPage({ params }: AboutPageProps) {
  const { sectionId } = await params
  redirect(`/professor/courses/${sectionId}`)
}
