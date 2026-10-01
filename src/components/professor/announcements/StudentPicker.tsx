/**
 * StudentPicker — searchable multi-select list for choosing students.
 *
 * Used in the announcement form to pick which students should receive
 * a "mentioned_only" announcement. Shows avatar initials, name, email,
 * with search filtering and select all/none controls.
 *
 * Type: Client Component
 */
'use client'

import { useState, useMemo } from 'react'
import { Search, Check, Users, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'

interface EnrolledStudent {
  id: string
  name: string | null
  email: string
}

interface StudentPickerProps {
  students: EnrolledStudent[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

export function StudentPicker({ students, selectedIds, onChange }: StudentPickerProps) {
  const [search, setSearch] = useState('')

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const filtered = useMemo(() => {
    if (!search.trim()) return students
    const q = search.toLowerCase()
    return students.filter((s) => {
      const name = (s.name || '').toLowerCase()
      const email = s.email.toLowerCase()
      return name.includes(q) || email.includes(q)
    })
  }, [students, search])

  const toggle = (id: string) => {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((sid) => sid !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  const selectAll = () => {
    onChange(filtered.map((s) => s.id))
  }

  const selectNone = () => {
    // Remove only filtered students from selection
    const filteredIds = new Set(filtered.map((s) => s.id))
    onChange(selectedIds.filter((id) => !filteredIds.has(id)))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <UserPlus className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Select Students</span>
          {selectedIds.length > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-1">
              {selectedIds.length} selected
            </Badge>
          )}
        </div>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={selectAll} className="h-6 text-[11px] px-2">
            All
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={selectNone} className="h-6 text-[11px] px-2">
            None
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-8 text-sm"
        />
      </div>

      {/* Student list */}
      <ScrollArea className="h-[200px] rounded-xl border">
        <div className="p-1">
          {filtered.length === 0 ? (
            <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <Users className="h-4 w-4 mr-2" />
              {students.length === 0 ? 'No enrolled students' : 'No students match your search'}
            </div>
          ) : (
            filtered.map((student) => {
              const isSelected = selectedSet.has(student.id)
              const initial = (student.name || student.email)[0].toUpperCase()

              return (
                <button
                  key={student.id}
                  type="button"
                  onClick={() => toggle(student.id)}
                  className={cn(
                    'flex items-center gap-2.5 w-full px-2 py-1.5 rounded-xl text-left transition-colors',
                    isSelected
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-muted/60'
                  )}
                >
                  {/* Avatar */}
                  <div className={cn(
                    'h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0',
                    isSelected
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  )}>
                    {initial}
                  </div>

                  {/* Name + Email */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate leading-tight">
                      {student.name || 'Unnamed'}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate leading-tight">
                      {student.email}
                    </p>
                  </div>

                  {/* Check */}
                  {isSelected && (
                    <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                  )}
                </button>
              )
            })
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
