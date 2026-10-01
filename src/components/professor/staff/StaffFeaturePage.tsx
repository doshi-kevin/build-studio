// Top-level client component for the professor's Staff (Course Assistants) tab.
// Merges active TAs/graders and their pending/rejected requests into a single
// unified roster so the professor sees the whole picture at a glance.
'use client'

import { useMemo, useState } from 'react'
import { UsersRound, Plus, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/professor/PageHeader'
import { SubmitStaffRequestDialog } from './SubmitStaffRequestDialog'
import { StaffList, type StaffEntry } from './StaffList'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any

interface StaffFeaturePageProps {
  sectionId: string
  sectionLabel: string
  sectionEndDate: string | null
  activeStaff: AnyRow[]
  requests: AnyRow[]
}

function resolveJoin<T>(val: T | T[] | null | undefined): T | null {
  if (!val) return null
  return Array.isArray(val) ? val[0] : val
}

const STATUS_RANK: Record<StaffEntry['status'], number> = {
  active: 0,
  pending: 1,
  rejected: 2,
}

export function StaffFeaturePage({
  sectionId,
  sectionLabel,
  sectionEndDate,
  activeStaff,
  requests,
}: StaffFeaturePageProps) {
  const [dialogOpen, setDialogOpen] = useState(false)

  const entries = useMemo<StaffEntry[]>(() => {
    const fromActive: StaffEntry[] = activeStaff.map((row) => {
      const staff = resolveJoin<AnyRow>(row.staff)
      return {
        key: `staff-${row.id}`,
        name: staff?.name ?? staff?.email ?? 'Unknown',
        email: staff?.email ?? '',
        role: row.role,
        status: 'active',
        endsAt: row.ends_at ?? null,
        // Only active staff have a profile to message — pending candidates
        // have no account yet, so they get no DM link.
        userId: staff?.id ?? null,
        invitePending: staff?.invite_status === 'pending' || staff?.onboarding_completed === false,
      }
    })

    // Requests with `section_staff_id` set have already been promoted into an
    // active staff row — skip to avoid duplicate rendering. Approved rows
    // without a link are edge cases that we still surface.
    const fromRequests: StaffEntry[] = requests
      .filter((row) => row.status !== 'approved' || !row.section_staff_id)
      .map((row) => ({
        key: `req-${row.id}`,
        name: [row.candidate_first_name, row.candidate_last_name].filter(Boolean).join(' ').trim() || row.candidate_email,
        email: row.candidate_email ?? '',
        role: row.requested_role,
        status: row.status === 'rejected' ? 'rejected' : 'pending',
        endsAt: row.ends_at ?? null,
        message: row.message ?? null,
        reviewNote: row.review_note ?? null,
        requestId: row.id,
      }))

    return [...fromActive, ...fromRequests].sort(
      (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name),
    )
  }, [activeStaff, requests])

  const activeCount = entries.filter((e) => e.status === 'active').length
  const pendingCount = entries.filter((e) => e.status === 'pending').length

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <PageHeader
        title="Course Assistants"
        description={
          <>
            Request a TA or grader for{' '}
            <span className="font-medium text-foreground">{sectionLabel}</span>. Every request is approved by your institution admin.
          </>
        }
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            Request assistant
          </Button>
        }
      />

      <div className="rounded-xl border border-info/30 bg-info-muted/40 p-4 flex gap-3">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-info-muted-foreground" />
        <div className="text-xs text-muted-foreground leading-relaxed space-y-1.5">
          <p>
            <span className="font-semibold text-foreground">How this works:</span> Submit a candidate with their email, role, and access end date. Your admin reviews and approves — once approved, the candidate gets an invite email and access activates. Access auto-expires on the end date you select.
          </p>
          <p>
            <span className="font-semibold text-foreground">TA vs Grader:</span> TAs can post announcements, grade, moderate discussions, and help with classroom. Graders can only grade submissions.
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Roster
          </h2>
          {entries.length > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {activeCount} active{pendingCount > 0 ? ` · ${pendingCount} pending` : ''}
            </span>
          )}
        </div>
        {entries.length === 0 ? (
          <EmptyState
            variant="teaching"
            icon={UsersRound}
            title="No course assistants yet"
            description="Request a TA or grader to help run this section. Submit a candidate and your institution admin takes it from there."
          >
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              Request assistant
            </Button>
          </EmptyState>
        ) : (
          <StaffList entries={entries} sectionId={sectionId} />
        )}
      </section>

      <SubmitStaffRequestDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        sectionId={sectionId}
        sectionEndDate={sectionEndDate}
      />
    </div>
  )
}
