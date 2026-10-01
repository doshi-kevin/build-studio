# Contributing to Scholera

## Prerequisites
- Node.js 22+ (see `.nvmrc`)
- npm 10+
- A Supabase account (or access to the scholera-prod project)

## Setup

1. Clone the repository
2. Navigate to `scholera-web/`
3. Copy environment variables:
   ```bash
   cp .env.example .env.local
   ```
   Required variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Install dependencies:
   ```bash
   npm install
   ```
5. Run the development server:
   ```bash
   npm run dev
   ```
6. Open http://localhost:3000

## Testing Accounts
- Sign up at /signup with any email
- All new users get `student` role by default
- To test as admin: manually update `profiles.role` to `institution_admin` in Supabase dashboard
- Dev mode: Use `kdoshi7@stevens.edu` for the DevModeSwitcher (bottom-right widget)

## Code Conventions

See `CLAUDE.md` for the full coding standards and architecture rules. Key highlights:
- Use `src/lib/logger.ts` for all logging (never raw `console.log`)
- Use `src/lib/supabase/queries.ts` for all database queries
- Use TypeScript types from `src/lib/supabase/types.ts`
- Server components for data fetching; client components only for interactivity

## Error Logging

All errors must go through the centralized logger:

```typescript
import { logger } from '@/lib/logger'

// Errors (with Supabase error object or Error instance)
logger.error('ModuleName.functionName', error, { userId, extra })

// Warnings (unexpected but recoverable)
logger.warn('Description of warning', { context })

// Info (significant events)
logger.info('User signed up', { userId, email })

// Debug (development only, suppressed in production)
logger.debug('Intermediate state', { data })
```

Source string format: `ComponentOrModule.functionName` for easy search.

## Component Guidelines

### Where to put components

| Type | Location | Example |
|------|----------|---------|
| shadcn/ui primitives | `src/components/ui/` | `button.tsx`, `card.tsx` |
| Shared dashboard components | `src/components/dashboard/` | `DashboardHeader.tsx` |
| Page-specific components | Co-locate in page file or `_components/` subfolder | Inline `DashboardCard` |
| Future: shared non-dashboard | `src/components/` (new subdirectory) | `landing/Hero.tsx` |

### Adding a shadcn component
```bash
npx shadcn@latest add [component-name]
```

### Component file conventions
- One component per file (except small local helpers)
- PascalCase file names matching the export: `DashboardHeader.tsx`
- Add `'use client'` directive only when the component needs hooks or event handlers
- Define props interface above the component: `interface ComponentNameProps { ... }`

## PR Process

1. Create a feature branch: `feature/short-description` or `fix/short-description`
2. Make changes, following conventions in `CLAUDE.md`
3. Update relevant `CONTEXT.md` files if you changed feature behavior
4. Run checks locally:
   ```bash
   npm run lint
   npm run typecheck
   npm run build
   ```
5. Create a PR — lead with *why* and include verification evidence
6. CI must pass before merge

## Available Scripts

```bash
npm run dev        # Start dev server at localhost:3000
npm run build      # Production build
npm run start      # Production server
npm run lint       # ESLint check
npm run typecheck  # TypeScript type check
```

## Project Documentation

| Document | Purpose |
|----------|---------|
| `CLAUDE.md` | AI assistant context: project overview, rules, file map |
| `CONTEXT.md` | Project vision and current status |
| `CONTRIBUTING.md` | This file: setup and contribution guide |
| `docs/README.md` | Index of `docs/` — start here |
| `supabase/migrations/` + `supabase/_snapshots/prod-schema.sql` | Database schema — the only sources of truth |
| `docs/designs/` | One system design per feature, grouped by domain |
| `src/**/CONTEXT.md` | Feature-specific context files |

When making significant changes, update the relevant `CONTEXT.md` file(s).
When making architectural decisions, write a system design in the matching
`docs/designs/<cluster>/` folder — see `docs/reference/system-design-rules.md`. (The old
`docs/decisions.md` ADR log was frozen in Feb 2026 and is archived; don't add to it.)
