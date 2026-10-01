/**
 * Professor Team Workspace Page — read-only drill-down into one team:
 * discussions, phases (with professor comments), members, contributions.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/projects/[projectId]/teams/[teamId]
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { projectQueries } from '@/lib/supabase/queries'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { TeamWorkspace } from '@/components/professor/projects/TeamWorkspace'

interface TeamWorkspacePageProps {
  params: Promise<{ sectionId: string; projectId: string; teamId: string }>
}

const PARTICIPATION_WINDOW_DAYS = 14

/** Time cutoffs for the activity read (kept out of the component body for render purity). */
function activityCutoffs() {
  const now = Date.now()
  return {
    sinceIso: new Date(now - PARTICIPATION_WINDOW_DAYS * 86400000).toISOString(),
    weekAgoMs: now - 7 * 86400000,
  }
}

export default async function TeamWorkspacePage({ params }: TeamWorkspacePageProps) {
  const { sectionId, projectId, teamId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) notFound()

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()
  const { adminDb } = access

  // Bind team -> project -> section before showing anything.
  const team = await projectQueries.getTeamDetail(adminDb, teamId)
  if (!team || team.project_id !== projectId) notFound()
  const project = Array.isArray(team.project) ? team.project[0] : team.project
  if (!project || project.section_id !== sectionId) notFound()

  const [members, phases, channels, docTitleRows] = await Promise.all([
    projectQueries.getProjectMembers(adminDb, projectId, teamId),
    projectQueries.getProjectPhases(adminDb, projectId, teamId),
    projectQueries.getTeamChannels(adminDb, teamId),
    projectQueries.getTeamDocTitles(adminDb, teamId),
  ])

  const { sinceIso, weekAgoMs } = activityCutoffs()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelIds = (channels as any[]).map((c) => c.id)
  const [activity, initialMessages] = await Promise.all([
    projectQueries.getTeamChatActivity(adminDb, channelIds, sinceIso),
    channelIds.length > 0
      ? projectQueries.getChannelMessages(adminDb, channelIds[0])
      : Promise.resolve([]),
  ])

  // Per-channel last activity + per-member post counts from one activity read.
  const lastByChannel = new Map<string, string>()
  const postsByAuthor = new Map<string, number>()
  let postsThisWeek = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of activity as any[]) {
    if (!lastByChannel.has(row.channel_id)) lastByChannel.set(row.channel_id, row.created_at)
    if (row.author_id) {
      postsByAuthor.set(row.author_id, (postsByAuthor.get(row.author_id) || 0) + 1)
    }
    if (new Date(row.created_at).getTime() >= weekAgoMs) postsThisWeek++
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const discussionChannels = (channels as any[]).map((c) => ({
    id: c.id,
    name: c.name,
    lastActivity: lastByChannel.get(c.id) ?? null,
  }))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const discussionMembers = (members as any[]).map((m) => ({
    userId: m.user_id,
    name: resolveJoin(m.profile)?.name || 'Unknown',
    posts14d: postsByAuthor.get(m.user_id) || 0,
  }))

  const phaseTitles: Record<string, string> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const p of phases as any[]) phaseTitles[p.id] = p.title
  const docTitles: Record<string, string> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of docTitleRows as any[]) docTitles[d.id] = d.title

  const pulse = {
    postsThisWeek,
    lastActivity: activity.length > 0 ? activity[0].created_at : null,
    membersPosting: discussionMembers.filter((m) => m.posts14d > 0).length,
    membersTotal: discussionMembers.length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    phasesDone: (phases as any[]).filter((p) => p.status === 'completed').length,
    phasesTotal: phases.length,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workspaceMembers = (members as any[]).map((m) => ({
    id: m.id,
    user_id: m.user_id,
    role: m.role,
    contribution_summary: m.contribution_summary,
    profile: resolveJoin(m.profile),
  }))

  return (
    <TeamWorkspace
      sectionId={sectionId}
      projectId={projectId}
      projectTitle={project.title}
      team={team}
      members={workspaceMembers}
      phases={phases}
      pulse={pulse}
      channels={discussionChannels}
      initialChannelId={channelIds[0] ?? null}
      initialMessages={initialMessages}
      discussionMembers={discussionMembers}
      phaseTitles={phaseTitles}
      docTitles={docTitles}
    />
  )
}
