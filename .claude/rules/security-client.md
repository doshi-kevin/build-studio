---
paths:
  - "src/components/**/*.tsx"
  - "src/components/**/*.jsx"
  - "src/app/**/*.tsx"
  - "src/app/**/*.jsx"
---

# Security Rules — Client Components

Applies to any file containing `'use client'` (and anything imported into a client component tree). This code ships to the browser — treat everything in it as public.

## Secrets must never reach the client

- **NEVER** reference `service_role` / `SUPABASE_SERVICE_ROLE_KEY`, `createAdminClient` (`@/lib/supabase/admin`), or any API key / DB credential in a client file or anything it imports. The service-role key bypasses RLS — in the browser bundle it is a full database compromise.
- Only `NEXT_PUBLIC_*` env vars are safe here (the anon key is *designed* to be public — that is correct, not a leak). Anything not prefixed `NEXT_PUBLIC_` is server-only.
- Server-only work (privileged DB writes, secret use) belongs in a server action — call it from the client, don't inline it.

## XSS — the #1 AI-generated flaw

- **NEVER** pass user-supplied content to `dangerouslySetInnerHTML` without sanitizing it first (e.g. DOMPurify). Prefer rendering as text.
- Don't build HTML by string concatenation from user data (a frequent stored-XSS source on export/share paths).
- If you add a `dangerouslySetInnerHTML`, justify why it's safe in a comment — it's a known XSS-sensitive surface.
- `PageCustomizeRenderer.tsx` renders professor-supplied HTML/CSS via `dangerouslySetInnerHTML` — a known, deliberate XSS-sensitive surface. Never widen what it accepts, and never copy its pattern to other user-supplied content.

When in doubt about whether a value is reachable in the browser: it is. Move the secret server-side.
