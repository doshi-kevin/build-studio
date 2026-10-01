'use client'

import { HardDrive } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { FILE_TYPE_COLORS, type WarehouseFile, type FileType } from '@/lib/validations/warehouse'
import { formatFileSize, getTotalStorageBytes } from '@/lib/warehouse/utils'

interface StorageHealthCardProps {
  files: WarehouseFile[]
}

export function StorageHealthCard({ files }: StorageHealthCardProps) {
  const totalBytes = getTotalStorageBytes(files)
  const mockMaxBytes = 15 * 1024 * 1024 * 1024 // 15 GB mock limit
  const usagePercent = Math.min((totalBytes / mockMaxBytes) * 100, 100)

  // Count by type
  const typeCounts: Record<FileType, number> = { pdf: 0, ppt: 0, video: 0, image: 0, doc: 0, other: 0 }
  for (const f of files) typeCounts[f.fileType]++

  // Files unused for 6+ months
  // eslint-disable-next-line react-hooks/purity
  const sixMonthsAgo = Date.now() - 180 * 86400000
  const unusedCount = files.filter((f) => new Date(f.lastUsedAt).getTime() < sixMonthsAgo).length

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <HardDrive className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Storage Health</span>
      </div>

      {/* Usage bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-muted-foreground mb-1 tabular-nums">
          <span>{formatFileSize(totalBytes)} used</span>
          <span>{formatFileSize(mockMaxBytes)}</span>
        </div>
        <Progress value={usagePercent} className="h-2" />
      </div>

      {/* Type breakdown */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        {(Object.entries(typeCounts) as [FileType, number][])
          .filter(([, count]) => count > 0)
          .map(([type, count]) => (
            <div key={type} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${FILE_TYPE_COLORS[type].dot}`} />
              <span className="text-muted-foreground tabular-nums">{count} {type}</span>
            </div>
          ))}
      </div>

      {/* Unused warning */}
      {unusedCount > 0 && (
        <p className="text-xs text-warning-muted-foreground mt-3 tabular-nums">
          {unusedCount} file{unusedCount !== 1 ? 's' : ''} unused for 6+ months
        </p>
      )}
    </div>
  )
}
