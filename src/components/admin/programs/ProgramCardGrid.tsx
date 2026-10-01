/**
 * ProgramCardGrid — rich card grid for the admin Programs landing page.
 *
 * Replaces the old ProgramTable with a more visual, scannable layout.
 * Each card shows: code, name, department, degree type, credits, status.
 * Clicking a card navigates to /admin/programs/[id] (full detail page).
 *
 * Toolbar provides:
 * - Client-side search (filters by name, code, or department name)
 * - Status filter
 * - Degree type filter
 * - "Add Program" button → CreateProgramDialog
 *
 * Per-card menu: View Details (link), Edit Program and Delete.
 *
 * Type: Client Component
 */
'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import {
  ScrollText,
  Building2,
  GraduationCap,
  BookOpen,
  Plus,
  Search,
  MoreHorizontal,
  Pencil,
  Eye,
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
import { CreateProgramDialog } from '@/components/admin/programs/CreateProgramDialog'
import { DeleteProgramDialog } from '@/components/admin/programs/DeleteProgramDialog'
import { EditProgramDialog } from '@/components/admin/programs/EditProgramDialog'
import {
  DEGREE_TYPE_LABELS,
  PROGRAM_STATUS_LABELS,
  type DegreeType,
  type ProgramStatus,
} from '@/lib/validations/program'
import { cn } from '@/lib/utils'

interface Department {
  id: string
  name: string
  code: string
}

interface Professor {
  id: string
  name: string
  email: string
}

interface ProgramCardGridProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  programs: any[]
  departments: Department[]
  professors: Professor[]
}

/** Monochrome style for degree type badges */
const DEGREE_BADGE_CLASS = 'border border-border bg-muted/50 text-foreground'

export function ProgramCardGrid({ programs, departments, professors }: ProgramCardGridProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [degreeFilter, setDegreeFilter] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
    code: string
  } | null>(null)
  /* Programs had no edit surface at all until #725 — updateProgram existed with
     zero callers, so a wrong name or code could only be fixed by deleting the
     program, which cascades to its courses. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [editTarget, setEditTarget] = useState<any | null>(null)

  const filtered = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return programs.filter((prog: any) => {
      const dept = prog.department
        ? Array.isArray(prog.department) ? prog.department[0] : prog.department
        : null
      const searchLower = search.toLowerCase()
      const matchSearch =
        search === '' ||
        (prog.name || '').toLowerCase().includes(searchLower) ||
        (prog.code || '').toLowerCase().includes(searchLower) ||
        (dept?.name || '').toLowerCase().includes(searchLower)
      const matchStatus =
        statusFilter === 'all' || prog.status === statusFilter
      const matchDegree =
        degreeFilter === 'all' || prog.degree_type === degreeFilter
      return matchSearch && matchStatus && matchDegree
    })
  }, [programs, search, statusFilter, degreeFilter])

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex flex-1 gap-3 flex-wrap">
          <div className="relative flex-1 max-w-xs min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search programs..."
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
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
          <Select value={degreeFilter} onValueChange={setDegreeFilter}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Degree" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Degrees</SelectItem>
              <SelectItem value="bachelor">Bachelor</SelectItem>
              <SelectItem value="master">Master</SelectItem>
              <SelectItem value="doctorate">Doctorate</SelectItem>
              <SelectItem value="certificate">Certificate</SelectItem>
              <SelectItem value="diploma">Diploma</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Program
        </Button>
      </div>

      {/* Summary line */}
      <p className="text-sm text-muted-foreground">
        {filtered.length} {filtered.length === 1 ? 'program' : 'programs'}
        {search && ` matching "${search}"`}
      </p>

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground gap-3 rounded-xl border border-dashed">
          <ScrollText className="w-8 h-8" />
          <p className="text-sm font-medium">
            {programs.length === 0
              ? 'No programs yet. Click "Add Program" to create one.'
              : 'No programs match your search.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {filtered.map((prog: any) => {
            const dept = prog.department
              ? Array.isArray(prog.department) ? prog.department[0] : prog.department
              : null

            return (
              <div
                key={prog.id}
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
                        <Link href={`/admin/programs/${prog.id}`}>
                          <Eye className="h-4 w-4 mr-2" />
                          View Details
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setEditTarget(prog)}>
                        <Pencil className="h-4 w-4 mr-2" />
                        Edit Program
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() =>
                          setDeleteTarget({ id: prog.id, name: prog.name, code: prog.code })
                        }
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Card body — clickable */}
                <Link href={`/admin/programs/${prog.id}`} className="block p-5 pr-10">
                  {/* Code + status */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">{prog.code}</span>
                    <span
                      className={cn(
                        'text-[11px] font-medium px-2 py-0.5 rounded-full border capitalize ml-auto',
                        prog.status === 'active'
                          ? 'bg-success-muted text-success-muted-foreground border-success/30'
                          : prog.status === 'archived'
                            ? 'bg-warning-muted text-warning-muted-foreground border-warning/30'
                            : 'bg-muted text-muted-foreground border-border'
                      )}
                    >
                      {PROGRAM_STATUS_LABELS[prog.status as ProgramStatus] || prog.status}
                    </span>
                  </div>

                  {/* Name */}
                  <p className="text-sm font-medium leading-snug mb-1 line-clamp-1">{prog.name}</p>

                  {/* Degree type badge */}
                  <div className="mb-3">
                    <span
                      className={cn(
                        'text-[11px] font-medium px-2 py-0.5 rounded-full',
                        DEGREE_BADGE_CLASS
                      )}
                    >
                      {DEGREE_TYPE_LABELS[prog.degree_type as DegreeType] || prog.degree_type}
                    </span>
                  </div>

                  {/* Description */}
                  {prog.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                      {prog.description}
                    </p>
                  )}

                  {/* Stats row */}
                  <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border/50">
                    {dept && (
                      <StatPill
                        icon={<Building2 className="w-3 h-3" />}
                        value={dept.code}
                        label={dept.name}
                      />
                    )}
                    {prog.total_credits != null && (
                      <StatPill
                        icon={<BookOpen className="w-3 h-3" />}
                        value={prog.total_credits}
                        label="credits"
                      />
                    )}
                    {prog.duration_semesters != null && (
                      <StatPill
                        icon={<GraduationCap className="w-3 h-3" />}
                        value={prog.duration_semesters}
                        label={prog.duration_semesters === 1 ? 'semester' : 'semesters'}
                      />
                    )}
                  </div>
                </Link>
              </div>
            )
          })}
        </div>
      )}

      <CreateProgramDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        departments={departments}
        professors={professors}
      />
      <EditProgramDialog
        open={!!editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null)
        }}
        departments={departments}
        professors={professors}
        program={editTarget}
      />
      <DeleteProgramDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        program={deleteTarget}
      />
    </div>
  )
}

function StatPill({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode
  value: number | string
  label: string
}) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {icon}
      <span className="font-medium text-foreground">{value}</span>
      <span className="line-clamp-1">{label}</span>
    </div>
  )
}
