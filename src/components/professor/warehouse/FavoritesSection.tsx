'use client'

import { Star } from 'lucide-react'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { FileCard } from './FileCard'
import type { WarehouseFile, WarehouseCourse } from '@/lib/validations/warehouse'

interface FavoritesSectionProps {
  files: WarehouseFile[]
  courses: WarehouseCourse[]
  onSelectFile: (fileId: string) => void
  onToggleFavorite: (fileId: string) => void
}

export function FavoritesSection({
  files,
  courses,
  onSelectFile,
  onToggleFavorite,
}: FavoritesSectionProps) {
  const favorites = files.filter((f) => f.favorite)
  if (favorites.length === 0) return null

  const courseMap = new Map(courses.map((c) => [c.id, c.name]))

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Star className="h-4 w-4 text-warning fill-warning" />
        <span className="text-sm font-semibold">Favorites</span>
        <span className="text-xs text-muted-foreground tabular-nums">({favorites.length})</span>
      </div>
      <AnimatedList className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {favorites.map((file) => (
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
