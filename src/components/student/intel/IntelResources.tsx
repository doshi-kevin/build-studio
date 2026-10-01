'use client'

import { useState, useMemo } from 'react'
import { Plus, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { ResourceCard } from './ResourceCard'
import { UploadResourceDialog } from './UploadResourceDialog'
import { deleteResource } from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'
import { RESOURCE_CATEGORIES, RESOURCE_CATEGORY_LABELS } from '@/lib/validations/intel'
import { toast } from 'sonner'

interface IntelResource {
  id: string
  title: string
  description?: string
  category: string
  file_url: string
  file_size?: number
  is_anonymous: boolean
  author_id: string
  created_at: string
  author?: { name?: string }
  author_name?: string
}

interface IntelResourcesProps {
  resources: IntelResource[]
  courseId: string
  sectionId: string
  userId: string
  isAlumni: boolean
}

export function IntelResources({
  resources,
  courseId,
  sectionId,
  userId,
  isAlumni,
}: IntelResourcesProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [dialogOpen, setDialogOpen] = useState(false)

  const filteredResources = useMemo(() => {
    if (selectedCategory === 'all') return resources
    return resources.filter((r) => r.category === selectedCategory)
  }, [resources, selectedCategory])

  const handleDelete = async (resourceId: string) => {
    const result = await deleteResource(resourceId, sectionId)
    if ('error' in result && result.error) {
      toast.error(result.error)
    } else {
      toast.success('Resource deleted')
    }
  }

  return (
    <div className="space-y-4">
      {/* Header: Filter + Upload */}
      <div className="flex items-center justify-between gap-3">
        <Select
          value={selectedCategory}
          onValueChange={setSelectedCategory}
        >
          <SelectTrigger className="w-[180px] h-9">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {RESOURCE_CATEGORIES.map((category) => (
              <SelectItem key={category} value={category}>
                {RESOURCE_CATEGORY_LABELS[category]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => setDialogOpen(true)}
          disabled={!isAlumni}
          title={!isAlumni ? 'Complete this course to upload resources' : ''}
        >
          <Plus className="h-3.5 w-3.5" />
          Upload Resource
        </Button>
      </div>

      {/* Resources Grid */}
      {filteredResources.length > 0 ? (
        <AnimatedList className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredResources.map((resource) => (
            <AnimatedItem key={resource.id}>
              <ResourceCard
                resource={{
                  ...resource,
                  author_name: resource.author?.name || resource.author_name,
                }}
                isOwn={resource.author_id === userId}
                onDelete={() => handleDelete(resource.id)}
              />
            </AnimatedItem>
          ))}
        </AnimatedList>
      ) : (
        <EmptyState
          variant={selectedCategory !== 'all' ? 'default' : 'teaching'}
          icon={FolderOpen}
          title={selectedCategory !== 'all' ? 'No resources in this category' : 'No resources yet'}
          description={
            selectedCategory !== 'all'
              ? 'Try selecting a different category or upload the first resource.'
              : 'Share study materials, notes, and practice exams with fellow students.'
          }
        />
      )}

      {/* Upload Resource Dialog */}
      <UploadResourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        courseId={courseId}
        sectionId={sectionId}
      />
    </div>
  )
}
