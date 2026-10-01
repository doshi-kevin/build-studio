/**
 * PickFromLibraryDialog — browse and pick a file from the professor's library (warehouse).
 *
 * Reads files from localStorage warehouse. Only shows files with a real fileUrl
 * (i.e. files actually uploaded to Supabase Storage).
 *
 * Type: Client Component
 */
'use client'

import { useState, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Library, Search, FileText, PlayCircle, Image, FileSpreadsheet, File } from 'lucide-react'
import { warehouseStorage } from '@/lib/warehouse/storage'
import { formatFileSize, getRelativeTime } from '@/lib/warehouse/utils'
import {
  FILE_TYPE_LABELS,
  FILE_TYPE_COLORS,
  type WarehouseFile,
  type WarehouseCourse,
  type FileType,
} from '@/lib/validations/warehouse'

const FILE_TYPE_ICONS: Record<FileType, typeof FileText> = {
  pdf: FileText,
  ppt: FileSpreadsheet,
  video: PlayCircle,
  image: Image,
  doc: FileText,
  other: File,
}

interface PickFromLibraryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Filter to only files with these fileTypes */
  acceptFileTypes?: FileType[]
  /** Called when the professor picks a file */
  onPick: (file: WarehouseFile) => void
}

export function PickFromLibraryDialog({
  open,
  onOpenChange,
  acceptFileTypes,
  onPick,
}: PickFromLibraryDialogProps) {
  const [search, setSearch] = useState('')

  // Load library files and courses directly from localStorage
  const allFiles = useMemo(() => {
    if (!open) return []
    return warehouseStorage.getFiles()
  }, [open])

  const courses = useMemo(() => {
    if (!open) return []
    return warehouseStorage.getCourses()
  }, [open])

  const courseMap = useMemo(() => {
    const map = new Map<string, WarehouseCourse>()
    for (const c of courses) map.set(c.id, c)
    return map
  }, [courses])

  // Filter: only files with a real fileUrl, matching types, matching search
  const filteredFiles = useMemo(() => {
    let result = allFiles.filter((f) => f.fileUrl) // Only files actually uploaded to storage
    if (acceptFileTypes?.length) {
      result = result.filter((f) => acceptFileTypes.includes(f.fileType))
    }
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.tags.some((t) => t.toLowerCase().includes(q)) ||
          f.topic.toLowerCase().includes(q),
      )
    }
    // Sort by lastUsedAt descending (most recently used first)
    result.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    return result
  }, [allFiles, acceptFileTypes, search])

  const handlePick = (file: WarehouseFile) => {
    onPick(file)
    onOpenChange(false)
    setSearch('')
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setSearch('') }}>
      <DialogContent className="max-w-lg max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Library className="h-5 w-5" />
            Pick from Library
          </DialogTitle>
          <DialogDescription>
            Select an existing file from your library.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* File list */}
        <ScrollArea className="max-h-[50vh]">
          {filteredFiles.length === 0 ? (
            <div className="text-center py-10">
              <Library className="h-8 w-8 mx-auto text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">
                {allFiles.filter((f) => f.fileUrl).length === 0
                  ? 'No uploaded files in your library yet.'
                  : 'No matching files found.'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Upload files to your library first, or upload directly to a module.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredFiles.map((file) => {
                const Icon = FILE_TYPE_ICONS[file.fileType] || File
                const colors = FILE_TYPE_COLORS[file.fileType]
                const course = file.courseId ? courseMap.get(file.courseId) : null

                return (
                  <button
                    key={file.id}
                    onClick={() => handlePick(file)}
                    className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-accent transition-colors text-left"
                  >
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${colors.chip}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{file.name}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                        <span>{formatFileSize(file.size)}</span>
                        <span className="text-muted-foreground/40">·</span>
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {FILE_TYPE_LABELS[file.fileType]}
                        </Badge>
                        {course && (
                          <>
                            <span className="text-muted-foreground/40">·</span>
                            <span className="truncate">{course.code || course.name}</span>
                          </>
                        )}
                        <span className="text-muted-foreground/40">·</span>
                        <span>{getRelativeTime(file.lastUsedAt)}</span>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
