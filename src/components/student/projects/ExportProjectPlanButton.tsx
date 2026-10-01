// Export dropdown button that lets students download their project plan as PDF or Word.
// Uses dynamic imports so jspdf/docx are only loaded on demand.

'use client'

import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ProjectExportData } from '@/lib/export/project-plan'

interface ExportProjectPlanButtonProps {
  data: ProjectExportData
}

export function ExportProjectPlanButton({ data }: ExportProjectPlanButtonProps) {
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null)

  const handleExport = async (format: 'pdf' | 'docx') => {
    setExporting(format)
    try {
      const { exportProjectPlanAsPdf, exportProjectPlanAsDocx } = await import(
        '@/lib/export/project-plan'
      )

      if (format === 'pdf') {
        await exportProjectPlanAsPdf(data)
      } else {
        await exportProjectPlanAsDocx(data)
      }

      toast.success(`Project plan exported as ${format.toUpperCase()}`)
    } catch {
      toast.error('Failed to export project plan. Please try again.')
    } finally {
      setExporting(null)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" disabled={!!exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {exporting ? 'Exporting...' : 'Export'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handleExport('pdf')} disabled={!!exporting}>
          Export as PDF
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport('docx')} disabled={!!exporting}>
          Export as Word
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
