// Users-by-role list for the Institution Detail page. Server-rendered.
// Pending institution_admin invites get an inline Resend button so super_admin
// can re-issue a temp-password welcome email when the original is lost.

import { ResendAdminInviteButton } from './ResendAdminInviteButton'

interface UserRow {
  id: string
  email: string
  name: string | null
  role: string
  invite_status: string | null
  last_login_at: string | null
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admins',
  institution_admin: 'Institution Admins',
  professor: 'Professors',
  course_assistant: 'Course Assistants',
  student: 'Students',
}

const ROLE_ORDER = ['super_admin', 'institution_admin', 'professor', 'course_assistant', 'student']

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function InviteStatusPill({ status }: { status: string | null }) {
  if (!status || status === 'accepted') {
    return <span className="text-muted-foreground">—</span>
  }
  const label = status === 'pending' ? 'Pending' : status.charAt(0).toUpperCase() + status.slice(1)
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground">
      {label}
    </span>
  )
}

export function InstitutionUsersList({ users }: { users: UserRow[] }) {
  const grouped = ROLE_ORDER.map((role) => ({
    role,
    label: ROLE_LABELS[role] || role,
    rows: users.filter((u) => u.role === role),
  })).filter((g) => g.rows.length > 0)

  if (grouped.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-background p-12 text-center">
        <h3 className="font-[family-name:var(--font-instrument-serif)] text-xl">No users yet</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Invite an institution admin first; they&apos;ll onboard the rest.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {grouped.map((group) => (
        <section key={group.role} className="rounded-2xl border border-border bg-background overflow-hidden">
          <header className="px-4 py-3 border-b border-border bg-muted/30 flex items-baseline justify-between">
            <h2 className="text-[11px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
              {group.label}
            </h2>
            <span className="text-[11px] text-muted-foreground tabular-nums">{group.rows.length}</span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Name</th>
                  <th className="text-left px-4 py-2 font-semibold">Email</th>
                  <th className="text-left px-4 py-2 font-semibold">Invite</th>
                  <th className="text-left px-4 py-2 font-semibold">Last login</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => {
                  const isPendingAdmin =
                    row.role === 'institution_admin' && row.invite_status === 'pending'
                  return (
                    <tr key={row.id} className="border-t border-border hover:bg-muted/20">
                      <td className="px-4 py-2">
                        {row.name || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2 font-mono text-[12px] text-muted-foreground truncate max-w-[260px]" title={row.email}>
                        {row.email}
                      </td>
                      <td className="px-4 py-2">
                        <InviteStatusPill status={row.invite_status} />
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDate(row.last_login_at)}</td>
                      <td className="px-4 py-2 text-right">
                        {isPendingAdmin && (
                          <ResendAdminInviteButton adminUserId={row.id} email={row.email} />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}
