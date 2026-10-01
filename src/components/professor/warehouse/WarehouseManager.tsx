'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/professor/PageHeader'
import { WarehouseProvider, useWarehouse } from './warehouse-context'
import { WarehouseToolbar } from './WarehouseToolbar'
import { WarehouseShelfView } from './WarehouseShelfView'
import { WarehouseFolderView } from './WarehouseFolderView'
import { WarehouseTimelineView } from './WarehouseTimelineView'
import { FileDetailPanel } from './FileDetailPanel'
import { UploadFileDialog } from './UploadFileDialog'
import { MoveFileDialog } from './MoveFileDialog'
import { DeleteFileDialog } from './DeleteFileDialog'
import { DeleteShelfDialog, type ShelfDeleteMode } from './DeleteShelfDialog'
import { warehouseStorage } from '@/lib/warehouse/storage'
import { getTotalStorageBytes, formatFileSize } from '@/lib/warehouse/utils'
import { generateId } from '@/lib/quiz/utils'
import { getProfessorCourseSections } from '@/app/(dashboard)/professor/warehouse/actions'
import { createClient } from '@/lib/supabase/client'
import { deleteFile as deleteStorageFile } from '@/lib/supabase/storage'
import type { WarehouseFile, WarehouseCourse, WarehouseTerm, Semester } from '@/lib/validations/warehouse'

// ── Helpers ──────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Inner Component (uses context) ──────────────────────────

function WarehouseInner({ professorId }: { professorId: string | null }) {
  const { state, dispatch } = useWarehouse()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [moveTarget, setMoveTarget] = useState<WarehouseFile | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WarehouseFile | null>(null)
  const [shelfDeleteTarget, setShelfDeleteTarget] = useState<{
    courseId: string | null
    course: WarehouseCourse | null
    fileCount: number
    isRealCourse: boolean
  } | null>(null)

  const courses = useMemo(() => Object.values(state.courses), [state.courses])
  const terms = useMemo(() => Object.values(state.terms), [state.terms])
  const allFiles = useMemo(() => Object.values(state.files), [state.files])

  // Filter files based on search + filters
  const filteredFiles = useMemo(() => {
    let result = allFiles

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase()
      result = result.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.tags.some((t) => t.toLowerCase().includes(q)) ||
          f.note.toLowerCase().includes(q) ||
          f.topic.toLowerCase().includes(q) ||
          (f.courseId && state.courses[f.courseId]?.name.toLowerCase().includes(q)),
      )
    }

    if (state.filterFileType) {
      result = result.filter((f) => f.fileType === state.filterFileType)
    }

    if (state.filterCourseId) {
      result = result.filter((f) => f.courseId === state.filterCourseId)
    }

    if (state.filterTermId) {
      result = result.filter((f) => f.termId === state.filterTermId)
    }

    return result
  }, [allFiles, state.searchQuery, state.filterFileType, state.filterCourseId, state.filterTermId, state.courses])

  // Detail panel
  const selectedFile = state.selectedFileId ? state.files[state.selectedFileId] ?? null : null

  // Handlers
  const handleUpload = useCallback(
    (file: WarehouseFile) => {
      dispatch({ type: 'ADD_FILE', payload: { file } })
      toast.success(`"${file.name}" added to your library`)
    },
    [dispatch],
  )

  const handleDuplicate = useCallback(
    (file: WarehouseFile) => {
      const now = new Date().toISOString()
      const newFile: WarehouseFile = {
        ...file,
        id: generateId(),
        name: `${file.name} (copy)`,
        createdAt: now,
        lastUsedAt: now,
        updatedAt: now,
      }
      dispatch({ type: 'DUPLICATE_FILE', payload: { originalId: file.id, newFile } })
      toast.success(`"${file.name}" duplicated`)
    },
    [dispatch],
  )

  const handleRename = useCallback(
    (file: WarehouseFile) => {
      const newName = window.prompt('Rename file:', file.name)
      if (newName && newName.trim() && newName !== file.name) {
        dispatch({
          type: 'UPDATE_FILE',
          payload: { file: { ...file, name: newName.trim(), updatedAt: new Date().toISOString() } },
        })
        toast.success('File renamed')
      }
    },
    [dispatch],
  )

  const handleMove = useCallback(
    (fileId: string, courseId: string | null, week: number | null, topic: string) => {
      dispatch({ type: 'MOVE_FILE', payload: { fileId, courseId, week, topic } })
      toast.success('File moved')
    },
    [dispatch],
  )

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    // Clean up from Supabase Storage if file has a real storage path
    if (deleteTarget.filePath) {
      const { error } = await deleteStorageFile(deleteTarget.filePath)
      if (error) {
        toast.error(`Failed to delete file from storage: ${error}`)
        return
      }
    }
    dispatch({ type: 'REMOVE_FILE', payload: { fileId: deleteTarget.id } })
    toast.success(`"${deleteTarget.name}" deleted`)
    setDeleteTarget(null)
  }, [dispatch, deleteTarget])

  // Open the shelf delete dialog (shared by "Clear All Files" and "Remove Shelf")
  const openShelfDelete = useCallback(
    (courseId: string | null) => {
      const course = courseId ? state.courses[courseId] ?? null : null
      const shelfFiles = allFiles.filter((f) =>
        courseId === null ? !f.courseId : f.courseId === courseId,
      )
      setShelfDeleteTarget({
        courseId,
        course,
        fileCount: shelfFiles.length,
        isRealCourse: !!(course?.sectionId),
      })
    },
    [state.courses, allFiles],
  )

  const handleShelfDelete = useCallback(
    async (mode: ShelfDeleteMode) => {
      if (!shelfDeleteTarget) return
      const { courseId } = shelfDeleteTarget

      // Delete files from Supabase Storage
      const shelfFiles = allFiles.filter((f) =>
        courseId === null ? !f.courseId : f.courseId === courseId,
      )
      for (const file of shelfFiles) {
        if (file.filePath) {
          await deleteStorageFile(file.filePath)
        }
      }

      if (mode === 'remove' && courseId) {
        // Remove course + unassign files (REMOVE_COURSE unassigns, then CLEAR_SHELF deletes)
        dispatch({ type: 'CLEAR_SHELF', payload: { courseId } })
        dispatch({ type: 'REMOVE_COURSE', payload: { courseId } })
        toast.success('Shelf removed')
      } else {
        // Clear files only
        dispatch({ type: 'CLEAR_SHELF', payload: { courseId } })
        toast.success('All files cleared from shelf')
      }

      setShelfDeleteTarget(null)
    },
    [dispatch, shelfDeleteTarget, allFiles],
  )

  return (
    <div className="space-y-6 overflow-hidden">
      {/* Header */}
      <PageHeader
        title="My Library"
        description="Your personal knowledge warehouse for course materials."
        actions={
          <Button onClick={() => setUploadOpen(true)}>
            <Upload className="h-4 w-4" />
            Upload
          </Button>
        }
      />

      {/* Toolbar */}
      <WarehouseToolbar
        searchQuery={state.searchQuery}
        onSearchChange={(query) => dispatch({ type: 'SET_SEARCH', payload: { query } })}
        filterFileType={state.filterFileType}
        onFilterFileTypeChange={(fileType) =>
          dispatch({ type: 'SET_FILTER_TYPE', payload: { fileType } })
        }
        filterCourseId={state.filterCourseId}
        onFilterCourseChange={(courseId) =>
          dispatch({ type: 'SET_FILTER_COURSE', payload: { courseId } })
        }
        courses={courses}
        viewMode={state.viewMode}
        onViewModeChange={(mode) => dispatch({ type: 'SET_VIEW_MODE', payload: { mode } })}
      />

      {allFiles.length > 0 && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {allFiles.length} file{allFiles.length !== 1 ? 's' : ''}
          {'  ·  '}
          {formatFileSize(getTotalStorageBytes(allFiles))} stored
        </p>
      )}

      {/* Active View */}
      {state.viewMode === 'warehouse' && (
        <WarehouseShelfView
          files={filteredFiles}
          courses={courses}
          terms={terms}
          expandedShelfId={state.expandedShelfId}
          expandedBoxId={state.expandedBoxId}
          onExpandShelf={(shelfId) => dispatch({ type: 'EXPAND_SHELF', payload: { shelfId } })}
          onExpandBox={(boxId) => dispatch({ type: 'EXPAND_BOX', payload: { boxId } })}
          onSelectFile={(fileId) => dispatch({ type: 'SELECT_FILE', payload: { fileId } })}
          onToggleFavorite={(fileId) => dispatch({ type: 'TOGGLE_FAVORITE', payload: { fileId } })}
          onRename={(file) => handleRename(file)}
          onMove={(file) => setMoveTarget(file)}
          onDuplicate={(file) => handleDuplicate(file)}
          onDelete={(file) => setDeleteTarget(file)}
          onEditNote={(fileId, note) => dispatch({ type: 'UPDATE_NOTE', payload: { fileId, note } })}
          onClearShelf={openShelfDelete}
          onRemoveShelf={openShelfDelete}
          onUpload={() => setUploadOpen(true)}
        />
      )}
      {state.viewMode === 'folder' && (
        <WarehouseFolderView
          files={filteredFiles}
          allFiles={allFiles}
          courses={courses}
          onSelectFile={(fileId) => dispatch({ type: 'SELECT_FILE', payload: { fileId } })}
          onToggleFavorite={(fileId) => dispatch({ type: 'TOGGLE_FAVORITE', payload: { fileId } })}
          onRename={(file) => handleRename(file)}
          onMove={(file) => setMoveTarget(file)}
          onDuplicate={(file) => handleDuplicate(file)}
          onDelete={(file) => setDeleteTarget(file)}
          onEditNote={(fileId, note) => dispatch({ type: 'UPDATE_NOTE', payload: { fileId, note } })}
        />
      )}
      {state.viewMode === 'timeline' && (
        <WarehouseTimelineView
          files={filteredFiles}
          courses={courses}
          terms={terms}
          onSelectFile={(fileId) => dispatch({ type: 'SELECT_FILE', payload: { fileId } })}
          onToggleFavorite={(fileId) => dispatch({ type: 'TOGGLE_FAVORITE', payload: { fileId } })}
          onRename={(file) => handleRename(file)}
          onMove={(file) => setMoveTarget(file)}
          onDuplicate={(file) => handleDuplicate(file)}
          onDelete={(file) => setDeleteTarget(file)}
          onEditNote={(fileId, note) => dispatch({ type: 'UPDATE_NOTE', payload: { fileId, note } })}
        />
      )}

      {/* Dialogs */}
      <UploadFileDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        courses={courses}
        terms={terms}
        professorId={professorId}
        onSave={handleUpload}
      />

      <MoveFileDialog
        open={!!moveTarget}
        onOpenChange={(open) => { if (!open) setMoveTarget(null) }}
        file={moveTarget}
        courses={courses}
        onMove={handleMove}
      />

      <DeleteFileDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        file={deleteTarget}
        onConfirm={handleDelete}
      />

      <DeleteShelfDialog
        open={!!shelfDeleteTarget}
        onOpenChange={(open) => { if (!open) setShelfDeleteTarget(null) }}
        course={shelfDeleteTarget?.course ?? null}
        fileCount={shelfDeleteTarget?.fileCount ?? 0}
        isRealCourse={shelfDeleteTarget?.isRealCourse ?? false}
        onConfirm={handleShelfDelete}
      />

      {/* Detail Panel */}
      <FileDetailPanel
        file={selectedFile}
        open={!!selectedFile}
        onOpenChange={(open) => {
          if (!open) dispatch({ type: 'SELECT_FILE', payload: { fileId: null } })
        }}
        courses={courses}
        onUpdateNote={(fileId, note) => dispatch({ type: 'UPDATE_NOTE', payload: { fileId, note } })}
        onToggleFavorite={(fileId) => dispatch({ type: 'TOGGLE_FAVORITE', payload: { fileId } })}
        onRename={(file) => handleRename(file)}
        onMove={(file) => {
          dispatch({ type: 'SELECT_FILE', payload: { fileId: null } })
          setMoveTarget(file)
        }}
        onDuplicate={(file) => handleDuplicate(file)}
        onDelete={(file) => {
          dispatch({ type: 'SELECT_FILE', payload: { fileId: null } })
          setDeleteTarget(file)
        }}
      />
    </div>
  )
}

// ── Outer Wrapper (loads data, provides context) ────────────

export function WarehouseManager() {
  const [ready, setReady] = useState(false)
  const [professorId, setProfessorId] = useState<string | null>(null)
  const [initialDispatch, setInitialDispatch] = useState<{
    files: WarehouseFile[]
    courses: WarehouseCourse[]
    terms: WarehouseTerm[]
  } | null>(null)

  useEffect(() => {
    async function init() {
      // 1. Get the professor's user ID
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) setProfessorId(user.id)

      // 2. Fetch real course sections from the server
      const sections = await getProfessorCourseSections()

      // 3. Build warehouse courses from real sections
      const realCourses: WarehouseCourse[] = sections.map((s) => ({
        id: s.id,
        name: s.course?.title ?? 'Unknown Course',
        code: s.course?.code ?? '',
        sectionId: s.id,
      }))

      // 4. Build terms (deduplicated)
      const termMap = new Map<string, WarehouseTerm>()
      for (const s of sections) {
        if (s.semester && s.year) {
          const termId = `${s.semester}-${s.year}`
          if (!termMap.has(termId)) {
            termMap.set(termId, {
              id: termId,
              label: `${capitalize(s.semester)} ${s.year}`,
              semester: s.semester as Semester,
              year: s.year,
            })
          }
        }
      }
      const realTerms = Array.from(termMap.values())

      // 5. Load existing localStorage data
      const existingFiles = warehouseStorage.getFiles()
      const existingCourses = warehouseStorage.getCourses()
      const existingTerms = warehouseStorage.getTerms()

      // 6. Merge: real courses take priority, keep extra manual/custom courses
      const realCourseIds = new Set(realCourses.map((c) => c.id))
      const extraCourses = existingCourses.filter((c) => !realCourseIds.has(c.id) && !c.sectionId)
      const mergedCourses = [...realCourses, ...extraCourses]

      const realTermIds = new Set(realTerms.map((t) => t.id))
      const extraTerms = existingTerms.filter((t) => !realTermIds.has(t.id))
      const mergedTerms = [...realTerms, ...extraTerms]

      // 7. Persist merged data
      warehouseStorage.saveCourses(mergedCourses)
      warehouseStorage.saveTerms(mergedTerms)

      setInitialDispatch({
        files: existingFiles,
        courses: mergedCourses,
        terms: mergedTerms,
      })
      setReady(true)
    }
    init()
  }, [])

  if (!ready || !initialDispatch) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-8 w-44 rounded-xl" />
            <Skeleton className="h-4 w-72 rounded-xl" />
          </div>
          <Skeleton className="h-9 w-28 rounded-xl" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-9 flex-1 rounded-xl" />
          <Skeleton className="h-9 w-32 rounded-xl" />
        </div>
        <div className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[72px] w-full rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <WarehouseProvider>
      <WarehouseDataLoader data={initialDispatch} professorId={professorId} />
    </WarehouseProvider>
  )
}

/** Loads initial data into context on mount */
function WarehouseDataLoader({
  data,
  professorId,
}: {
  data: { files: WarehouseFile[]; courses: WarehouseCourse[]; terms: WarehouseTerm[] }
  professorId: string | null
}) {
  const { dispatch } = useWarehouse()

  useEffect(() => {
    dispatch({
      type: 'SET_DATA',
      payload: data,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only on mount

  return <WarehouseInner professorId={professorId} />
}
