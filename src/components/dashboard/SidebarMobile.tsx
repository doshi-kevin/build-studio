/**
 * SidebarMobile — slide-out navigation drawer for mobile viewports.
 *
 * Uses the shadcn Sheet component (side="left") to render the same navigation
 * items as the desktop Sidebar. Triggered by the hamburger icon in DashboardHeader.
 *
 * Automatically closes when a navigation link is clicked (via onOpenChange).
 *
 * Type: Client Component (needs usePathname, useState)
 * Props: role — user's role, open/onOpenChange — controlled by parent
 */
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SIDEBAR_ITEMS } from '@/components/dashboard/Sidebar'
import { cn } from '@/lib/utils'

interface SidebarMobileProps {
  role: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SidebarMobile({ role, open, onOpenChange }: SidebarMobileProps) {
  const pathname = usePathname()
  const items = SIDEBAR_ITEMS[role] || SIDEBAR_ITEMS.student

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-64 p-0">
        <SheetHeader className="px-4 py-4 border-b border-border">
          <SheetTitle className="font-[family-name:var(--font-instrument-serif)] text-[20px] tracking-tight">Schol<em className="italic">era</em></SheetTitle>
        </SheetHeader>
        <nav className="px-3 py-4 space-y-1">
          {items.map((item) => {
            const isActive = item.href === '/dashboard' || item.href === '/admin'
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(item.href + '/')
            const Icon = item.icon

            if (item.disabled) {
              return (
                <div
                  key={item.href}
                  className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-muted-foreground/50 rounded-md cursor-not-allowed"
                >
                  <Icon className="h-5 w-5" />
                  <span>{item.label}</span>
                  <span className="ml-auto text-xs text-muted-foreground/30">Soon</span>
                </div>
              )
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => onOpenChange(false)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                <Icon className="h-5 w-5" />
                <span>{item.label}</span>
              </Link>
            )
          })}
        </nav>
      </SheetContent>
    </Sheet>
  )
}
