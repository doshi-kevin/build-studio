'use client'

import { format } from 'date-fns'
import { FileText, Download, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RESOURCE_CATEGORY_LABELS } from '@/lib/validations/intel'
import { formatFileSize } from '@/lib/supabase/storage'
import { safeExternalUrl } from '@/components/shared/modules/module-item-display'

interface Resource {
  id: string
  title: string
  description?: string
  category: string
  file_url: string
  file_size?: number
  is_anonymous: boolean
  author_name?: string
  created_at: string
}

interface ResourceCardProps {
  resource: Resource
  isOwn: boolean
  onDelete?: () => void
}

export function ResourceCard({ resource, isOwn, onDelete }: ResourceCardProps) {
  const authorName = resource.is_anonymous
    ? 'Anonymous'
    : resource.author_name || 'Unknown'
  const categoryLabel =
    RESOURCE_CATEGORY_LABELS[
      resource.category as keyof typeof RESOURCE_CATEGORY_LABELS
    ] || resource.category

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3 hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out">
      {/* Title + Category */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <h4 className="font-semibold text-sm truncate text-foreground">{resource.title}</h4>
        </div>
        <Badge variant="secondary">{categoryLabel}</Badge>
      </div>

      {/* Description */}
      {resource.description && (
        <p className="text-sm text-muted-foreground leading-relaxed break-words">
          {resource.description}
        </p>
      )}

      {/* File Size + Download */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          {resource.file_size ? formatFileSize(resource.file_size) : 'Unknown size'}
        </span>

        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="gap-1.5 h-8" asChild>
            {/* safeExternalUrl even though file_url is now server-derived (#700's pattern,
                found here in security review): rows written before this change still hold
                whatever the client sent, and a stored javascript: value was neutralised
                only by React's own href guard. */}
            <a href={safeExternalUrl(resource.file_url) ?? undefined} target="_blank" rel="noopener noreferrer">
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          </Button>

          {isOwn && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              aria-label="Delete your resource"
              title="Delete your resource"
              className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 p-0 text-destructive hover:bg-destructive-muted hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Footer: Author + Date */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{authorName}</span>
        <span>{format(new Date(resource.created_at), 'MMM d, yyyy')}</span>
      </div>
    </div>
  )
}
