// Tabbed wrapper for the admin TA/Grader hub. Combines the directory
// of approved staff with the pending-request queue so admins manage
// both surfaces from a single page. The "Pending" tab carries a count
// badge so unhandled requests stay visible from the directory view.
'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Users, Inbox } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StaffDirectoryTable } from '@/components/admin/staff/StaffDirectoryTable'
import { StaffRequestQueue } from '@/components/admin/staff-requests/StaffRequestQueue'

interface Department {
  id: string
  name: string
  code: string
}

interface StaffHubProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assignments: any[]
  departments: Department[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pendingRequests: any[]
}

type TabValue = 'directory' | 'requests'

export function StaffHub({ assignments, departments, pendingRequests }: StaffHubProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initial = searchParams.get('tab') === 'requests' ? 'requests' : 'directory'
  const [tab, setTab] = useState<TabValue>(initial)

  // Keep the URL in sync so deep-links (e.g. from a notification) land
  // on the right tab and a back/forward navigation restores it too.
  useEffect(() => {
    const current = searchParams.get('tab')
    const target = tab === 'requests' ? 'requests' : null
    if (target === current) return
    const params = new URLSearchParams(searchParams.toString())
    if (target) params.set('tab', target)
    else params.delete('tab')
    const qs = params.toString()
    router.replace(qs ? `/admin/staff?${qs}` : '/admin/staff', { scroll: false })
  }, [tab, router, searchParams])

  const pendingCount = pendingRequests.length

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="w-full">
      <TabsList className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground gap-1">
        <TabsTrigger
          value="directory"
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
        >
          <Users className="h-3.5 w-3.5" />
          Directory
          <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/10 px-1.5 text-xs font-medium">
            {assignments.length}
          </span>
        </TabsTrigger>
        <TabsTrigger
          value="requests"
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
        >
          <Inbox className="h-3.5 w-3.5" />
          Pending Requests
          {pendingCount > 0 && (
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary text-primary-foreground px-1.5 text-xs font-semibold">
              {pendingCount}
            </span>
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="directory" className="mt-6">
        <StaffDirectoryTable assignments={assignments} departments={departments} />
      </TabsContent>

      <TabsContent value="requests" className="mt-6">
        <StaffRequestQueue requests={pendingRequests} />
      </TabsContent>
    </Tabs>
  )
}
