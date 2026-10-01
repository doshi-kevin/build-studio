'use client'

// Role-aware navigation sidebar shown on the left side of the dashboard.
// Hidden on mobile (lg breakpoint) — mobile uses SidebarMobile (Sheet drawer).
// Hidden entirely when inside a course container (course has its own sidebar).

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  GraduationCap,
  Building2,
  Users,
  UserCircle,
  CalendarDays,
  Clock,
  BookOpen,
  Megaphone,
  MessageSquare,
  UsersRound,
  Globe,
  Shield,
  ShieldAlert,
  BarChart3,
  Inbox,
  PackageCheck,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface SidebarItem {
  label: string
  href: string
  icon: LucideIcon
  disabled?: boolean
}

const SIDEBAR_ITEMS: Record<string, SidebarItem[]> = {
  super_admin: [
    { label: 'Institutions', href: '/super-admin', icon: Globe },
    { label: 'AI Controls', href: '/super-admin/ai-controls', icon: ShieldAlert },
    { label: 'Plans', href: '/super-admin/plans', icon: PackageCheck },
    { label: 'Feature Requests', href: '/super-admin/feature-requests', icon: Inbox },
    { label: 'Cost Analysis', href: '/super-admin/cost-analysis', icon: BarChart3 },
    { label: 'Super Admins', href: '/super-admin/team', icon: Shield },
  ],
  institution_admin: [
    { label: 'Dashboard', href: '/admin', icon: LayoutDashboard },
    { label: 'Departments', href: '/admin/departments', icon: Building2 },
    { label: 'Professors', href: '/admin/professors', icon: GraduationCap },
    { label: 'Students', href: '/admin/students', icon: Users },
    { label: 'Course Assistants', href: '/admin/staff', icon: UsersRound },
    { label: 'Administrators', href: '/admin/admins', icon: Shield },
    { label: 'Feedback', href: '/admin/feedback', icon: MessageSquare },
    { label: 'Settings', href: '/admin/settings', icon: Settings },
  ],
  professor: [
    { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { label: 'My Courses', href: '/professor/courses', icon: BookOpen },
    { label: 'Calendar', href: '/professor/calendar', icon: CalendarDays },
    /* 'My Library' (/professor/warehouse) is withdrawn until it has real persistence.
       Its storage layer is a localStorage mock — nothing reached the server, a cache
       clear destroyed everything, and a second account on the same browser saw the
       first professor's files. Deliberately hidden rather than deleted: the UI is
       reusable once the Supabase-backed repository exists. */
  ],
  course_assistant: [
    { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { label: 'My Sections', href: '/staff/courses', icon: UsersRound },
  ],
  student: [
    { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { label: 'My Courses', href: '/student/courses', icon: BookOpen },
    { label: 'Calendar', href: '/student/calendar', icon: CalendarDays },
    { label: 'Announcements', href: '/student/announcements', icon: Megaphone },
    { label: 'Office Hours', href: '/student/office-hours', icon: Clock },
    { label: 'My Profile', href: '/student/profile', icon: UserCircle },
  ],
}

const EXACT_MATCH_ROUTES = ['/dashboard', '/admin', '/super-admin']

function SidebarLink({ item, pathname }: { item: SidebarItem; pathname: string }) {
  const isActive = EXACT_MATCH_ROUTES.includes(item.href)
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + '/')
  const Icon = item.icon

  if (item.disabled) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground/40 rounded-lg cursor-not-allowed">
        <Icon className="h-4 w-4 shrink-0" />
        <span>{item.label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground/30 font-medium">Soon</span>
      </div>
    )
  }

  return (
    <Link
      href={item.href}
      className={cn(
        'flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors',
        isActive
          ? 'bg-primary text-primary-foreground font-medium'
          : 'text-muted-foreground font-medium hover:bg-muted hover:text-foreground'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{item.label}</span>
    </Link>
  )
}

interface SidebarProps {
  role: string
}

const HIDE_SIDEBAR_PATTERN = /^\/(professor|student|staff)\/courses\/[^/]+/

export function Sidebar({ role }: SidebarProps) {
  const pathname = usePathname()

  if (HIDE_SIDEBAR_PATTERN.test(pathname)) return null

  const items = SIDEBAR_ITEMS[role] || SIDEBAR_ITEMS.student

  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-60 border-r border-border/50 bg-background shrink-0 overflow-y-auto overflow-x-hidden">
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {items.map((item) => (
          <SidebarLink key={item.href} item={item} pathname={pathname} />
        ))}
      </nav>
    </aside>
  )
}

export { SIDEBAR_ITEMS }
export type { SidebarItem }
