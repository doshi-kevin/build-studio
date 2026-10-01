'use client'

import { Clock } from 'lucide-react'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { FileCard } from './FileCard'
import type { WarehouseFile, WarehouseCourse } from '@/lib/validations/warehouse'

interface RecentFilesSectionProps {
  files: WarehouseFile[]
  courses: WarehouseCourse[]
  onSelectFile: (fileId: string) => void
  onToggleFavorite: (fileId: string) => void
}

export function RecentFilesSection({
  files,
  courses,
  onSelectFile,
  onToggleFavorite,
}: RecentFilesSectionProps) {
  const recent = [...files]
    .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    .slice(0, 8)

  if (recent.length === 0) return null

  const courseMap = new Map(courses.map((c) => [c.id, c.name]))

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Recently Used</span>
      </div>
      <AnimatedList className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {recent.map((file) => (
          <AnimatedItem key={file.id}>
            <FileCard
              file={file}
              courseName={file.courseId ? courseMap.get(file.courseId) : undefined}
              onSelect={() => onSelectFile(file.id)}
              onToggleFavorite={() => onToggleFavorite(file.id)}
              compact
            />
          </AnimatedItem>
        ))}
      </AnimatedList>
    </div>
  )
}
