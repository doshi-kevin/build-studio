// The plugin frame document. Served only on the dedicated runtime origin
// (STUDIO_RUNTIME_ORIGIN); middleware 404s this path on the app origin.
// All checks live in frameResponse.
import type { NextRequest } from 'next/server'
import { frameResponse } from '@/lib/studio/runtime/frame'
import { requestHost } from '@/lib/studio/runtime/origin'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ installationId: string; view: string }> },
) {
  const { installationId, view } = await params
  return frameResponse(requestHost(request), installationId, view, request.nextUrl.searchParams.get('t'))
}
