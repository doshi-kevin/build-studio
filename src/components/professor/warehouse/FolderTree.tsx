'use client'

import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  BookOpen,
  CalendarDays,
  Star,
  Clock,
  FileQuestion,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { WarehouseFile, WarehouseCourse } from '@/lib/validations/warehouse'

export type TreeNode = {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  count: number
  children?: TreeNode[]
}

interface FolderTreeProps {
  files: WarehouseFile[]
  courses: WarehouseCourse[]
  activeNodeId: string
  onNodeSelect: (nodeId: string) => void
}

function buildTree(files: WarehouseFile[], courses: WarehouseCourse[]): TreeNode[] {
  const tree: TreeNode[] = []

  // All Files
  tree.push({ id: 'all', label: 'All Files', icon: FolderOpen, count: files.length })

  // By Course
  for (const course of courses) {
    const courseFiles = files.filter((f) => f.courseId === course.id)

    // Group by week within course
    const weekMap = new Map<number, WarehouseFile[]>()
    for (const f of courseFiles) {
      const key = f.week ?? 0
      const arr = weekMap.get(key) ?? []
      arr.push(f)
      weekMap.set(key, arr)
    }

    const weekChildren: TreeNode[] = [...weekMap.entries()]
      .sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : a[0] - b[0]))
      .map(([weekNum, weekFiles]) => ({
        id: `course-${course.id}-w${weekNum}`,
        label: weekNum === 0 ? 'Unassigned' : `Week ${weekNum}`,
        icon: CalendarDays,
        count: weekFiles.length,
      }))

    tree.push({
      id: `course-${course.id}`,
      label: course.code ? `${course.code} — ${course.name}` : course.name,
      icon: BookOpen,
      count: courseFiles.length,
      children: weekChildren,
    })
  }

  // Favorites
  const favCount = files.filter((f) => f.favorite).length
  if (favCount > 0) {
    tree.push({ id: 'favorites', label: 'Favorites', icon: Star, count: favCount })
  }

  // Recent
  tree.push({ id: 'recent', label: 'Recent', icon: Clock, count: Math.min(files.length, 20) })

  // Unsorted
  const unsortedCount = files.filter((f) => !f.courseId).length
  if (unsortedCount > 0) {
    tree.push({ id: 'unsorted', label: 'Unsorted', icon: FileQuestion, count: unsortedCount })
  }

  return tree
}

function TreeNodeItem({
  node,
  activeNodeId,
  onNodeSelect,
  depth = 0,
}: {
  node: TreeNode
  activeNodeId: string
  onNodeSelect: (id: string) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(depth === 0 || activeNodeId.startsWith(node.id))
  const hasChildren = node.children && node.children.length > 0
  const isActive = activeNodeId === node.id
  const Icon = node.icon

  return (
    <div>
      <button
        onClick={() => {
          onNodeSelect(node.id)
          if (hasChildren) setExpanded(!expanded)
        }}
        className={cn(
          'w-full flex items-center gap-2 px-2 py-1.5 rounded-xl text-sm transition-colors',
          isActive
            ? 'bg-primary/10 text-primary font-medium'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )
        ) : (
          <span className="w-3.5" />
        )}
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate flex-1 text-left">{node.label}</span>
        <Badge variant="secondary" className="text-xs ml-auto">
          {node.count}
        </Badge>
      </button>

      {hasChildren && expanded && (
        <div>
          {node.children!.map((child) => (
            <TreeNodeItem
              key={child.id}
              node={child}
              activeNodeId={activeNodeId}
              onNodeSelect={onNodeSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FolderTree({ files, courses, activeNodeId, onNodeSelect }: FolderTreeProps) {
  const tree = buildTree(files, courses)

  return (
    <nav className="space-y-0.5">
      {tree.map((node) => (
        <TreeNodeItem
          key={node.id}
          node={node}
          activeNodeId={activeNodeId}
          onNodeSelect={onNodeSelect}
        />
      ))}
    </nav>
  )
}
