// GET /api/studio/builder/runs/[runId]?after=<seq>: the professor's progress read for one
// build. Owner-only: readProgress compares the run's owner with the session user and
// returns null for every other caller, which becomes the same 404. A route rather than a
// server action, because Next runs one client's actions one at a time and a 1.5 s poll
// would queue the Stop click behind it.
import { NextResponse, type NextRequest } from 'next/server'
import { readProgress } from '@/lib/studio/builder/service'

export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })

export async function GET(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  const after = Number(request.nextUrl.searchParams.get('after') ?? '0')
  const progress = await readProgress(runId, Number.isInteger(after) && after >= 0 ? after : 0)
  if (!progress) return notFound()
  return NextResponse.json(progress, { headers: { 'Cache-Control': 'no-store' } })
}
