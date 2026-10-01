/**
 * FacultyTable — interactive faculty table for the department detail page.
 *
 * Replaces the previous read-only faculty table. Provides:
 * - "Add Faculty" button that opens AddFacultyDialog
 * - Per-row actions: Remove from department
 * - Displays name, email, title, position, status
 *
 * Type: Client Component (needs useState for dialog states)
 */
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Plus, MoreHorizontal, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AddFacultyDialog } from '@/components/admin/departments/AddFacultyDialog'
import { removeProfessorFromDepartment } from '@/app/(dashboard)/admin/professors/actions'
import { POSITION_LABELS, type Position } from '@/lib/validations/professor'

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  inactive: 'secondary',
  on_leave: 'outline',
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  inactive: 'Inactive',
  on_leave: 'On Leave',
}

interface FacultyMember {
  id: string
  professor_id: string
  title: string | null
  position: string | null
  status: string
  professor: { id: string; name: string | null; email: string } | { id: string; name: string | null; email: string }[] | null
  source?: 'section'
}

interface AvailableProfessor {
  id: string
  name: string | null
  email: string
}

interface FacultyTableProps {
  faculty: FacultyMember[]
  departmentId: string
  availableProfessors: AvailableProfessor[]
}

export function FacultyTable({ faculty, departmentId, availableProfessors }: FacultyTableProps) {
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  const handleRemove = async (facultyId: string, professorName: string) => {
    const result = await removeProfessorFromDepartment(facultyId)
    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }
    toast.success(`${professorName} removed from department`)
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setAddDialogOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add Faculty
        </Button>
      </div>

      {faculty.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center">
              <Users className="h-10 w-10 mx-auto text-muted-foreground/60 mb-3" />
              <p className="text-muted-foreground font-medium">No faculty assigned</p>
              <p className="text-sm text-muted-foreground/60 mt-1">
                Add professors from the Professors page first, then assign them here.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {faculty.map((member) => {
                  const profRaw = member.professor
                  const prof = Array.isArray(profRaw) ? profRaw[0] : profRaw
                  const profName = prof?.name || 'Unknown'
                  const isFromSection = member.source === 'section'
                  return (
                    <TableRow key={member.id}>
                      <TableCell className="font-medium">
                        <Link href={`/admin/professors/${member.professor_id}`} className="hover:underline">
                          {profName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {prof?.email || '—'}
                      </TableCell>
                      <TableCell>
                        {isFromSection ? (
                          <span className="text-xs text-muted-foreground italic">Via course sections</span>
                        ) : member.position ? (
                          POSITION_LABELS[member.position as Position] || member.position
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[member.status] || 'secondary'}>
                          {STATUS_LABELS[member.status] || member.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {!isFromSection && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                                <span className="sr-only">Actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => handleRemove(member.id, profName)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Remove from Department
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <AddFacultyDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        departmentId={departmentId}
        availableProfessors={availableProfessors}
      />
    </div>
  )
}
