// The builder's draft preview frame. Served only on the runtime origin
// (STUDIO_RUNTIME_ORIGIN); middleware 404s this path on the app origin.
// All checks live in draftFrameResponse.
import type { NextRequest } from 'next/server'
import { draftFrameResponse } from '@/lib/studio/runtime/frame'
import { requestHost } from '@/lib/studio/runtime/origin'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; view: string }> },
) {
  const { projectId, view } = await params
  return draftFrameResponse(requestHost(request), projectId, view, request.nextUrl.searchParams.get('t'))
}
