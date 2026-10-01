// Magic-link / invite / recovery URL generator via the Supabase Admin API.
// Replaces the need for a real email inbox in tests (Gemini's correction).
//
// supabase.auth.admin.generateLink returns { action_link } which is the
// full URL the user would click in their email. Point Playwright at it with
// page.goto(link) and you hit the same auth callback the real flow uses.

import { admin } from './db'

export type LinkType = 'invite' | 'recovery' | 'magiclink' | 'signup'

export async function generateAuthLink(opts: {
  type: LinkType
  email: string
  redirectTo?: string
  password?: string
}): Promise<string> {
  // supabase-js types generateLink as a discriminated union on `type`, so a
  // generic LinkType param cannot satisfy any one variant. Cast at the call
  // site — the runtime accepts this shape for every supported type.
  const params = {
    type: opts.type,
    email: opts.email,
    password: opts.password,
    options: opts.redirectTo ? { redirectTo: opts.redirectTo } : undefined,
  } as Parameters<typeof admin.auth.admin.generateLink>[0]
  const { data, error } = await admin.auth.admin.generateLink(params)
  if (error || !data?.properties?.action_link) {
    throw new Error(
      `generateLink(${opts.type}) failed for ${opts.email}: ${error?.message ?? 'no action_link returned'}`,
    )
  }
  return data.properties.action_link
}
