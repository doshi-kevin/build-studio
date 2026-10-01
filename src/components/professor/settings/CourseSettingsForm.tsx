/**
 * CourseSettingsForm — client form for editing course section settings.
 *
 * Sections: Dates, Enrollment, Capacity & Location, Visibility, Import,
 * Danger Zone (archive). Each section is a self-contained card with a clear
 * heading, helper text, and grouped fields. A sticky save bar keeps the
 * primary action reachable.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Calendar, Users, MapPin, Monitor, Archive, RotateCcw, Copy } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { MODALITY_LABELS, type Modality } from '@/lib/validations/course-assignment'
import {
  updateSectionSettings,
  archiveSection,
  restoreSection,
} from '@/app/(dashboard)/professor/courses/[sectionId]/settings/actions'
import { CloneFromSectionDialog } from './CloneFromSectionDialog'

interface CourseSettingsFormProps {
  sectionId: string
  initialData: {
    start_date: string | null
    end_date: string | null
    max_students: number | null
    modality: string | null
    location: string | null
    status: string
  }
}

/** A titled settings card: icon + heading + optional helper, then fields. */
function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`bg-card border border-border rounded-xl p-6 ${className ?? ''}`}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </section>
  )
}

export function CourseSettingsForm({ sectionId, initialData }: CourseSettingsFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [startDate, setStartDate] = useState(initialData.start_date || '')
  const [endDate, setEndDate] = useState(initialData.end_date || '')
  const [maxStudents, setMaxStudents] = useState(initialData.max_students?.toString() || '')
  const [modality, setModality] = useState(initialData.modality || '')
  const [location, setLocation] = useState(initialData.location || '')
  const [status, setStatus] = useState(initialData.status)

  const isArchived = status === 'archived'
  const isCancelled = status === 'cancelled'
  const locked = isArchived || isCancelled

  const handleSave = () => {
    startTransition(async () => {
      const result = await updateSectionSettings(sectionId, {
        start_date: startDate || null,
        end_date: endDate || null,
        max_students: maxStudents ? parseInt(maxStudents, 10) : null,
        modality: (modality || null) as Modality | null,
        location: location || null,
        status: status as 'draft' | 'active',
      })

      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Settings saved')
      }
    })
  }

  const handleArchive = () => {
    startTransition(async () => {
      const result = await archiveSection(sectionId)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Course archived')
        router.push('/professor/courses')
      }
    })
  }

  const handleRestore = () => {
    startTransition(async () => {
      const result = await restoreSection(sectionId)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Course restored')
        setStatus('active')
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* Status banner */}
      {locked && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-warning/30 bg-warning-muted p-4">
          <div className="flex items-center gap-3">
            <StatusIndicator status={status} />
            <span className="text-sm text-warning-muted-foreground">
              {isArchived
                ? 'This course is archived. Students cannot access it.'
                : 'This course has been cancelled by an administrator.'}
            </span>
          </div>
          {isArchived && (
            <Button variant="outline" size="sm" onClick={handleRestore} disabled={isPending}>
              <RotateCcw className="h-3.5 w-3.5" />
              Restore
            </Button>
          )}
        </div>
      )}

      {/* Dates */}
      <SettingsSection
        icon={Calendar}
        title="Course dates"
        description="When the course runs. Used across the calendar and student timelines."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="start_date">Start date</Label>
            <Input
              id="start_date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={locked}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="end_date">End date</Label>
            <Input
              id="end_date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={locked}
            />
          </div>
        </div>
      </SettingsSection>

      {/* Capacity & Location */}
      <SettingsSection
        icon={Users}
        title="Capacity & location"
        description="Cap the roster and tell students where and how the class meets."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="max_students">Max students</Label>
              <Input
                id="max_students"
                type="number"
                min={1}
                max={500}
                placeholder="No limit"
                value={maxStudents}
                onChange={(e) => setMaxStudents(e.target.value)}
                disabled={locked}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="modality">Modality</Label>
              <Select value={modality} onValueChange={setModality} disabled={locked}>
                <SelectTrigger id="modality" className="w-full">
                  <SelectValue placeholder="Not set" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(MODALITY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="location" className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              Location
            </Label>
            <Input
              id="location"
              placeholder="e.g. Room 201, Engineering Building"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              disabled={locked}
            />
          </div>
        </div>
      </SettingsSection>

      {/* Visibility */}
      {!locked && (
        <SettingsSection
          icon={Monitor}
          title="Visibility"
          description="Control whether enrolled students can access this section."
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">
                  <div className="flex items-center gap-2">
                    <StatusIndicator status="draft" showLabel={false} />
                    Draft
                  </div>
                </SelectItem>
                <SelectItem value="active">
                  <div className="flex items-center gap-2">
                    <StatusIndicator status="active" showLabel={false} />
                    Active
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {status === 'draft'
                ? 'Draft courses are hidden from students.'
                : 'Active courses are visible to enrolled students.'}
            </p>
          </div>
        </SettingsSection>
      )}

      {/* Save bar */}
      {!locked && (
        <div className="sticky bottom-0 z-10 flex items-center justify-between gap-4 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <p className="text-xs text-muted-foreground">Changes apply to this section only.</p>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}

      {/* Import from Previous Course */}
      <SettingsSection
        icon={Copy}
        title="Import content"
        description="Copy modules, items, and settings from one of your other courses into this one."
      >
        <CloneFromSectionDialog sectionId={sectionId} />
      </SettingsSection>

      {/* Danger Zone */}
      {!locked && (
        <section className="bg-card border border-destructive/30 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-destructive-muted">
              <Archive className="h-4 w-4 text-destructive-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-foreground">Archive course</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Archiving hides this course from students. You can restore it later.
              </p>
              <div className="mt-5">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-destructive/30 text-destructive hover:bg-destructive-muted"
                    >
                      <Archive className="h-3.5 w-3.5" />
                      Archive course
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Archive this course?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Students will lose access to this course section. You can restore it anytime from your courses page.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={handleArchive}>
                        Archive
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
