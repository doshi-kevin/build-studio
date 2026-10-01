/**
 * DepartmentCardGrid — rich card grid for the admin Departments landing page.
 *
 * Replaces the old DepartmentTable with a more visual, scannable layout.
 * Each card shows: dept code, name, status, and counts for courses, faculty, programs.
 * Clicking a card navigates to /admin/departments/[id] (full detail page).
 *
 * Toolbar provides:
 * - Client-side search (filters by name or code)
 * - Status filter
 * - "New Department" button → CreateDepartmentDialog
 *
 * Per-card ⋯ menu: Edit (link to detail page) and Delete (opens confirm dialog).
 *
 * Type: Client Component
 */
'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import {
  Building2,
  BookOpen,
  GraduationCap,
  ScrollText,
  Plus,
  Search,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CreateDepartmentDialog } from '@/components/admin/departments/CreateDepartmentDialog'
import { DeleteDepartmentDialog } from '@/components/admin/departments/DeleteDepartmentDialog'
import { cn } from '@/lib/utils'

interface DepartmentWithCounts {
  id: string
  name: string
  code: string
  description: string | null
  office_location: string | null
  contact_email: string | null
  status: string
  programCount: number
  courseCount: number
  facultyCount: number
}

interface DepartmentCardGridProps {
  departments: DepartmentWithCounts[]
}

export function DepartmentCardGrid({ departments }: DepartmentCardGridProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
    code: string
  } | null>(null)

  const filtered = useMemo(() => {
    return departments.filter((d) => {
      const matchSearch =
        search === '' ||
        d.name.toLowerCase().includes(search.toLowerCase()) ||
        d.code.toLowerCase().includes(search.toLowerCase())
      const matchStatus = statusFilter === 'all' || d.status === statusFilter
      return matchSearch && matchStatus
    })
  }, [departments, search, statusFilter])

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex flex-1 gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search departments…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Department
        </Button>
      </div>

      {/* Summary line */}
      <p className="text-sm text-muted-foreground">
        {filtered.length} {filtered.length === 1 ? 'department' : 'departments'}
        {search && ` matching "${search}"`}
      </p>

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground gap-3 rounded-xl border border-dashed">
          <Building2 className="w-8 h-8" />
          <p className="text-sm font-medium">
            {departments.length === 0
              ? 'No departments yet. Click "New Department" to create one.'
              : 'No departments match your search.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((dept) => (
            <div
              key={dept.id}
              className="group relative rounded-xl border border-border bg-card hover:border-foreground/30 hover:shadow-sm transition-[border-color,box-shadow]"
            >
              {/* ⋯ menu — overlay on top right */}
              <div className="absolute top-3 right-3 z-10">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => e.preventDefault()}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                      <span className="sr-only">Actions</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href={`/admin/departments/${dept.id}`}>
                        <Pencil className="h-4 w-4 mr-2" />
                        Edit
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() =>
                        setDeleteTarget({ id: dept.id, name: dept.name, code: dept.code })
                      }
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Card body — clickable */}
              <Link href={`/admin/departments/${dept.id}`} className="block p-5 pr-10">
                {/* Code + status */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">{dept.code}</span>
                  <span
                    className={cn(
                      'text-[11px] font-medium px-2 py-0.5 rounded-full border capitalize ml-auto',
                      dept.status === 'active'
                        ? 'bg-success-muted text-success-muted-foreground border-success/30'
                        : 'bg-muted text-muted-foreground border-border'
                    )}
                  >
                    {dept.status}
                  </span>
                </div>

                {/* Name */}
                <p className="text-sm font-medium leading-snug mb-1 line-clamp-1">{dept.name}</p>

                {/* Description */}
                {dept.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                    {dept.description}
                  </p>
                )}

                {/* Stats row */}
                <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border/50">
                  <StatPill icon={<BookOpen className="w-3 h-3" />} value={dept.courseCount} label="courses" />
                  {/* "appointed", not "faculty" (#717 part 2). This count is formal `department_faculty`
                      rows only, while the department detail page counts those PLUS professors who
                      own a section in the department. Both numbers are right; showing them under
                      the same bare label "faculty" is what made one department read 1 here and 2
                      there. The detail side already says "Teaching (N appointed)", so this matches
                      its vocabulary instead of changing either definition. */}
                  <StatPill icon={<GraduationCap className="w-3 h-3" />} value={dept.facultyCount} label="appointed" />
                  <StatPill icon={<ScrollText className="w-3 h-3" />} value={dept.programCount} label="programs" />
                </div>
              </Link>
            </div>
          ))}
        </div>
      )}

      <CreateDepartmentDialog open={createOpen} onOpenChange={setCreateOpen} />
      <DeleteDepartmentDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        department={deleteTarget}
      />
    </div>
  )
}

function StatPill({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {icon}
      <span className="font-medium text-foreground">{value}</span>
      <span>{label}</span>
    </div>
  )
}
