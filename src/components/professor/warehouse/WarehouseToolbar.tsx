'use client'

import { Search, LayoutGrid, FolderTree, Clock } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FILE_TYPES, FILE_TYPE_LABELS, type FileType, type WarehouseCourse } from '@/lib/validations/warehouse'
import type { ViewMode } from './warehouse-context'

interface WarehouseToolbarProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  filterFileType: FileType | null
  onFilterFileTypeChange: (type: FileType | null) => void
  filterCourseId: string | null
  onFilterCourseChange: (courseId: string | null) => void
  courses: WarehouseCourse[]
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
}

export function WarehouseToolbar({
  searchQuery,
  onSearchChange,
  filterFileType,
  onFilterFileTypeChange,
  filterCourseId,
  onFilterCourseChange,
  courses,
  viewMode,
  onViewModeChange,
}: WarehouseToolbarProps) {
  return (
    <div className="flex flex-col sm:flex-row gap-3">
      {/* Search */}
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search files, tags, notes..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Filters + View Mode + Upload */}
      <div className="flex gap-2 flex-wrap items-center">
        {/* File type filter */}
        <Select
          value={filterFileType ?? 'all'}
          onValueChange={(v) => onFilterFileTypeChange(v === 'all' ? null : (v as FileType))}
        >
          <SelectTrigger className="w-30 sm:w-35">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {FILE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {FILE_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Course filter */}
        {courses.length > 0 && (
          <Select
            value={filterCourseId ?? 'all'}
            onValueChange={(v) => onFilterCourseChange(v === 'all' ? null : v)}
          >
            <SelectTrigger className="w-32 sm:w-40">
              <SelectValue placeholder="All Courses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Courses</SelectItem>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.code ? `${c.code} — ${c.name}` : c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* View mode toggle */}
        <ToggleGroup
          type="single"
          value={viewMode}
          onValueChange={(v) => {
            if (v) onViewModeChange(v as ViewMode)
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="warehouse" aria-label="Warehouse view" className="px-2.5">
            <LayoutGrid className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="folder" aria-label="Folder view" className="px-2.5">
            <FolderTree className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="timeline" aria-label="Timeline view" className="px-2.5">
            <Clock className="h-4 w-4" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  )
}
