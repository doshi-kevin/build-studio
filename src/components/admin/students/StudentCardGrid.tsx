/**
 * StudentCardGrid — rich card grid for the admin Students landing page.
 *
 * Replaces the old StudentTable with a more visual, scannable layout.
 * Each card shows: name, email, CWID, phone, status.
 * Clicking a card navigates to /admin/students/[id] (full detail page).
 *
 * Toolbar provides:
 * - Client-side search (filters by name, email, or CWID)
 * - Status filter
 * - "Add Student" button → CreateStudentDialog
 *
 * Per-card menu: View Details (link) and Delete.
 *
 * Type: Client Component
 */
'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import {
  GraduationCap,
  Plus,
  Search,
  MoreHorizontal,
  Eye,
  Trash2,
  Mail,
  Phone,
  Hash,
  Upload,
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
import { CreateStudentDialog } from '@/components/admin/students/CreateStudentDialog'
import { BulkAddStudentsDialog } from '@/components/admin/students/BulkAddStudentsDialog'
import { DeleteStudentDialog } from '@/components/admin/students/DeleteStudentDialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { INVITE_STATUS_LABELS, INVITE_STATUS_TOOLTIPS } from '@/lib/validations/invite-status'
import { cn } from '@/lib/utils'

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  inactive: 'Inactive',
  suspended: 'Suspended',
}

interface Department {
  id: string
  name: string
  code: string
}

interface Student {
  id: string
  email: string
  name: string | null
  first_name: string | null
  last_name: string | null
  cwid: string | null
  phone: string | null
  status: string
  invite_status?: string
}

interface StudentCardGridProps {
  students: Student[]
  departments: Department[]
}

export function StudentCardGrid({ students, departments }: StudentCardGridProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
    email: string
  } | null>(null)

  const filtered = useMemo(() => {
    return students.filter((student) => {
      const searchLower = search.toLowerCase()
      const matchSearch =
        search === '' ||
        (student.name || '').toLowerCase().includes(searchLower) ||
        student.email.toLowerCase().includes(searchLower) ||
        (student.cwid || '').includes(search)
      const matchStatus =
        statusFilter === 'all' || student.status === statusFilter
      return matchSearch && matchStatus
    })
  }, [students, search, statusFilter])

  const getDisplayName = (student: Student) =>
    student.name ||
    `${student.first_name || ''} ${student.last_name || ''}`.trim() ||
    student.email

  const getInitials = (student: Student) => {
    const name =
      student.name || `${student.first_name || ''} ${student.last_name || ''}`.trim()
    if (!name) return student.email[0].toUpperCase()
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex flex-1 gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, or CWID..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setBulkOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Bulk Add
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Student
          </Button>
        </div>
      </div>

      {/* Summary line */}
      <p className="text-sm text-muted-foreground">
        {filtered.length} {filtered.length === 1 ? 'student' : 'students'}
        {search && ` matching "${search}"`}
      </p>

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground gap-3 rounded-xl border border-dashed">
          <GraduationCap className="w-8 h-8" />
          <p className="text-sm font-medium">
            {students.length === 0
              ? 'No students yet. Click "Add Student" to add one.'
              : 'No students match your search.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((student) => (
            <div
              key={student.id}
              className="group relative rounded-xl border border-border bg-card hover:border-foreground/30 hover:shadow-sm transition-[border-color,box-shadow]"
            >
              {/* Menu overlay */}
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
                      <Link href={`/admin/students/${student.id}`}>
                        <Eye className="h-4 w-4 mr-2" />
                        View Details
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() =>
                        setDeleteTarget({
                          id: student.id,
                          name: getDisplayName(student),
                          email: student.email,
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Card body — clickable */}
              <Link href={`/admin/students/${student.id}`} className="block p-5 pr-10">
                {/* Avatar + Name */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full border border-border bg-muted/50 text-foreground flex items-center justify-center text-sm font-semibold shrink-0">
                    {getInitials(student)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-snug line-clamp-1">
                      {getDisplayName(student)}
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-1 flex items-center gap-1">
                      <Mail className="w-3 h-3 shrink-0" />
                      {student.email}
                    </p>
                  </div>
                </div>

                {/* Status badge — invite-lifecycle takes priority while not yet active.
                    Only once the student is past onboarding does the admin's
                    active/inactive/suspended toggle drive the badge. */}
                <div className="flex items-center gap-2 mb-3">
                  {student.invite_status && student.invite_status !== 'active' ? (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className={cn(
                              'text-[11px] font-medium px-2 py-0.5 rounded-full border cursor-help',
                              student.invite_status === 'pending'
                                ? 'bg-foreground/10 text-foreground border-border'
                                : student.invite_status === 'accepted'
                                  ? 'bg-foreground/10 text-foreground border-border'
                                  : 'bg-destructive/10 text-destructive border-destructive/20'
                            )}
                          >
                            {INVITE_STATUS_LABELS[student.invite_status] || student.invite_status}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>{INVITE_STATUS_TOOLTIPS[student.invite_status] || ''}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <span
                      className={cn(
                        'text-[11px] font-medium px-2 py-0.5 rounded-full border capitalize',
                        student.status === 'active'
                          ? 'bg-success-muted text-success-muted-foreground border-success/30'
                          : student.status === 'suspended'
                            ? 'bg-destructive/10 text-destructive border-destructive/20'
                            : 'bg-muted text-muted-foreground border-border'
                      )}
                    >
                      {STATUS_LABELS[student.status] || student.status}
                    </span>
                  )}
                </div>

                {/* Info row */}
                <div className="flex items-center gap-3 pt-3 border-t border-border/50">
                  {student.cwid && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Hash className="w-3 h-3" />
                      <span className="font-mono font-medium text-foreground">{student.cwid}</span>
                    </div>
                  )}
                  {student.phone && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Phone className="w-3 h-3" />
                      <span>{student.phone}</span>
                    </div>
                  )}
                  {!student.cwid && !student.phone && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <GraduationCap className="w-3 h-3" />
                      <span>Student</span>
                    </div>
                  )}
                </div>
              </Link>
            </div>
          ))}
        </div>
      )}

      <CreateStudentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        departments={departments}
      />
      <BulkAddStudentsDialog open={bulkOpen} onOpenChange={setBulkOpen} />
      <DeleteStudentDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        student={deleteTarget}
      />
    </div>
  )
}
