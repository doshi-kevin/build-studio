/**
 * Template Marketplace — full-page view.
 * Reached from AssignmentStudioEntry → "Browse the Template Marketplace" link.
 *
 * Shows the 3 core creators at top, then the full MarketplaceBrowser below.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments/new/marketplace
 */
import Link from 'next/link'
import { ArrowLeft, LayoutGrid } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { assignmentQueries } from '@/lib/supabase/queries'
import { toAllTemplateHistory } from '@/lib/assignments/studio/template-history'
import { MarketplaceBrowser } from '@/components/professor/assignments/MarketplaceBrowser'

interface MarketplacePageProps {
  params: Promise<{ sectionId: string }>
}

export default async function MarketplacePage({ params }: MarketplacePageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const [rows, savedTemplateIds] = user
    ? await Promise.all([
        assignmentQueries.listAuthoredAssignments(supabase, user.id),
        assignmentQueries.listSavedTemplateIds(supabase, user.id),
      ])
    : [[], []]
  const recentTemplates = toAllTemplateHistory(rows, 60)

  return (
    <div className="space-y-6">
      <Link
        href={`/professor/courses/${sectionId}/assignments/new`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to new assignment
      </Link>

      {/* Compact header — mirrors the former modal header. */}
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <LayoutGrid className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-foreground">Template Marketplace</h1>
          <p className="text-sm text-muted-foreground">Pick a template to start from. You can edit everything before publishing.</p>
        </div>
      </div>

      <MarketplaceBrowser
        sectionId={sectionId}
        myTemplates={recentTemplates}
        initialSavedIds={savedTemplateIds}
      />
    </div>
  )
}
