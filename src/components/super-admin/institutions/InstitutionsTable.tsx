// Server-rendered table listing all institutions with counts and admin-presence
// warning. Each row links to /super-admin/institutions/[id] (detail view, future).

import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { StatusPill } from './StatusPill'

export interface InstitutionRow {
  id: string
  name: string
  slug: string
  status: string
  created_at: string
  total_users: number
  admin_count: number
}

interface Props {
  institutions: InstitutionRow[]
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function InstitutionsTable({ institutions }: Props) {
  if (institutions.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-background p-12 text-center">
        <h3 className="font-[family-name:var(--font-instrument-serif)] text-xl">No institutions yet</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Create your first institution to start onboarding a university.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border bg-background overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Institution</th>
              <th className="text-left px-4 py-3 font-semibold">Slug</th>
              <th className="text-left px-4 py-3 font-semibold">Status</th>
              <th className="text-right px-4 py-3 font-semibold">Users</th>
              <th className="text-left px-4 py-3 font-semibold">Admins</th>
              <th className="text-left px-4 py-3 font-semibold">Created</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {institutions.map((row) => {
              const noAdmin = row.admin_count === 0
              return (
                <tr key={row.id} className="border-t border-border hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{row.name}</div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-[12px] text-muted-foreground">{row.slug}</code>
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={row.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{row.total_users}</td>
                  <td className="px-4 py-3">
                    {noAdmin ? (
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground"
                        title="This institution has no institution_admin assigned. Invite one to hand off operations."
                      >
                        <AlertTriangle className="h-3 w-3" />
                        No admin assigned
                      </span>
                    ) : (
                      <span className="text-[13px] tabular-nums">{row.admin_count}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(row.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/super-admin/institutions/${row.id}`}
                      className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                    >
                      Open
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
