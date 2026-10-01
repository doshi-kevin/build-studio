'use client'

/**
 * SkillsManager — the professor's curation surface for the section skill pool
 * (Skill Mastery). Skills auto-populate from module-material extraction; here
 * the professor reviews the recommended list: drag to reorder, uncheck to drop
 * from tracking (soft-exclude), rename, add, or remove. Two-level tree (main
 * skills + subtopics). Mastery analytics live on the roadmap.
 *
 * Skinned in the roadmap drawer's design language (roadmap-prototype.css §17).
 * The delete confirm is an in-drawer card (.tsset), NOT a portaled
 * AlertDialog: body portals stack at z-50 UNDER the z-61 drawer, so the old
 * dialog was invisible and its overlay routed every click to the drawer's
 * scrim — clicking "Remove" closed the drawer and deleted nothing.
 */

import { memo, useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2, ListTree, Loader2, Check, X, Pencil, GripVertical, ChevronRight, Bot } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { trapTab } from './focus-trap'
import type { SkillTreeNode, SkillRow } from '@/lib/validations/skill'
import type { SkillIndexNode } from '@/lib/skills/index-view'
import { CoverageBadges, MasteryDelta, MasteryValue } from './SkillIndexView'
import {
  addSkill,
  renameSkill,
  deleteSkill,
  setSkillExcluded,
  setSkillSuppressed,
  reorderSkills,
  suggestSkillPlacement,
} from '@/app/(dashboard)/professor/courses/[sectionId]/skills/actions'

interface SkillsManagerProps {
  sectionId: string
  initialTree: SkillTreeNode[]
  /** Per-skill coverage + mastery (id → node), shown as badges. Absent while the
   *  coverage index is still loading — the list stays fully editable regardless. */
  coverageById?: Map<string, SkillIndexNode>
  /** Per-skill class mastery change since the trend baseline, whole points.
   *  Absent for a section with too little history to compare. */
  trendById?: Map<string, number>
  /** Open the shared ConceptDetail modal for a skill (score · assessed · taught). */
  onOpenConcept?: (name: string) => void
}

type ActionResult = { success?: true; error?: string } & Record<string, unknown>

/* SortableContext ids. ONE DndContext covers the whole tree — the id of the
   context a drag started in tells us which list to reorder. (A context per main
   row meant 76 DndContexts + 76 sensor sets on a 75-main section.) */
const MAINS = 'skills:mains'
const SUBS_PREFIX = 'skills:subs:'

export function SkillsManager({ sectionId, initialTree, coverageById, trendById, onOpenConcept }: SkillsManagerProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [newMain, setNewMain] = useState('')
  const [placing, setPlacing] = useState(false)
  /* Subtopics are COLLAPSED by default. A section can carry hundreds of skills
     (75 mains / 320 subtopics is a real one), and rendering every subtopic up
     front put ~20k nodes and a useSortable per row into the drawer. Mains stay
     the scannable index; open one to work on its subtopics. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  /** Run a server action, surface errors as toasts, refresh on success. */
  const run = useCallback((action: () => Promise<ActionResult>, onOk?: () => void) => {
    startTransition(async () => {
      const res = await action()
      if (res?.error) {
        toast.error(res.error)
        return
      }
      onOk?.()
      router.refresh()
    })
  }, [router])

  /** Add a skill; AI nests it under the best-fitting main skill when one fits. */
  async function handleAdd() {
    const name = newMain.trim()
    if (!name) return
    setPlacing(true)
    const res = await suggestSkillPlacement(sectionId, name)
    setPlacing(false)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    const parentId = res.parentId ?? undefined
    run(
      () => addSkill({ sectionId, name, parentId }),
      () => {
        setNewMain('')
        toast.success(res.parentName ? `Added under ${res.parentName}` : 'Skill added')
      },
    )
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  /** Reorder within one list — mains, or one main's subtopics. Drops that cross
   *  lists are ignored (re-parenting a subtopic by drag isn't a gesture here). */
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const list = active.data.current?.sortable?.containerId as string | undefined
    if (!list || list !== over.data.current?.sortable?.containerId) return
    const parentId = list === MAINS ? null : list.slice(SUBS_PREFIX.length)
    const ids = parentId === null
      ? initialTree.filter((t) => !t.suppressed).map((t) => t.id)
      : initialTree.find((t) => t.id === parentId)?.subtopics.map((s) => s.id)
    if (!ids) return
    const from = ids.indexOf(active.id as string)
    const to = ids.indexOf(over.id as string)
    if (from === -1 || to === -1) return
    run(() => reorderSkills({ sectionId, parentId, orderedIds: arrayMove(ids, from, to) }))
  }

  // Tracked skills the professor manages; suggested = AI concepts the corroboration
  // gate hasn't promoted, shown as an opt-in group so they're never silently lost.
  // A dismissed suggestion is soft-excluded (not deleted) → it leaves this group,
  // isn't scored, and the reconcile dedupe won't re-suggest it (rejection memory).
  const tracked = initialTree.filter((n) => !n.suppressed)
  const suggested = initialTree.filter((n) => n.suppressed && !n.excluded)

  // Main-row removal asks first (it can take subtopics with it) — via an
  // in-drawer card, never a portaled dialog (see the header comment).
  const [confirmRemove, setConfirmRemove] = useState<SkillTreeNode | null>(null)

  return (
    <div>
      {/* Add a skill — kept at the top so it's always reachable without scrolling */}
      <div className="tsadd">
        <input
          value={newMain}
          onChange={(e) => setNewMain(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
          placeholder="Add a skill…"
          maxLength={120}
          disabled={pending}
        />
        <button
          type="button"
          className="tsbtn"
          onClick={handleAdd}
          disabled={pending || placing || !newMain.trim()}
          title="AI nests it under the best-fitting main skill"
        >
          {placing ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          Add
        </button>
      </div>

      {initialTree.length === 0 ? (
        <div className="tsempty">
          <span className="ic"><ListTree aria-hidden /></span>
          <h4>No skills yet</h4>
          <p>
            Upload course material in Modules — Scholera extracts the skills it covers and lists
            them here automatically. You can also add one yourself above.
          </p>
        </div>
      ) : (
        <>
          {/* Caption above the list (the drawer header already reads "Tracked skills"). */}
          {tracked.length > 0 && <p className="tscap">Uncheck a skill to stop tracking it.</p>}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext id={MAINS} items={tracked.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <div>
                {tracked.map((node) => (
                  <MainSkillRow
                    key={node.id}
                    sectionId={sectionId}
                    node={node}
                    pending={pending}
                    run={run}
                    coverageById={coverageById}
                    trendById={trendById}
                    onOpenConcept={onOpenConcept}
                    expanded={expanded.has(node.id)}
                    onToggle={toggleExpanded}
                    onRequestRemove={setConfirmRemove}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {confirmRemove && (
            <RemoveConfirmCard
              node={confirmRemove}
              pending={pending}
              onCancel={() => setConfirmRemove(null)}
              onConfirm={() =>
                run(
                  () => deleteSkill({ sectionId, skillId: confirmRemove.id }),
                  () => {
                    setConfirmRemove(null)
                    toast.success('Skill removed')
                  },
                )
              }
            />
          )}

          {suggested.length > 0 && (
            <div className="tssugg">
              <div className="sh">
                <Bot aria-hidden />
                Suggested ({suggested.length})
              </div>
              <p className="sd">
                Concepts Scholera found but isn’t tracking yet — they only showed up once and aren’t assessed. Track the ones worth following.
              </p>
              <div>
                {suggested.map((node) => (
                  <div key={node.id} className="tsrow sub">
                    <span className="tsname" style={{ flex: 1 }}><span className="nm">{node.name}</span></span>
                    <button
                      type="button"
                      className="tsbtn ghost sm"
                      disabled={pending}
                      onClick={() =>
                        run(
                          () => setSkillSuppressed({ sectionId, skillId: node.id, suppressed: false }),
                          () => toast.success(`Tracking “${node.name}”`),
                        )
                      }
                    >
                      <Plus aria-hidden /> Track
                    </button>
                    <button
                      type="button"
                      className="tsdel"
                      aria-label={`Dismiss ${node.name}`}
                      title="Dismiss — won't be suggested again"
                      disabled={pending}
                      onClick={() =>
                        run(
                          () => setSkillExcluded({ sectionId, skillId: node.id, excluded: true }),
                          () => toast.success(`Dismissed “${node.name}”`),
                        )
                      }
                    >
                      <X aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Drag handle ─────────────────────────────────────────────────

function DragHandle({
  listeners,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listeners: any
}) {
  return (
    <button type="button" className="tsgrip" aria-label="Drag to reorder" {...listeners}>
      <GripVertical aria-hidden />
    </button>
  )
}

// ── Main skill row (subtopics collapsed until the chevron is opened) ──

const MainSkillRow = memo(function MainSkillRow({
  sectionId,
  node,
  pending,
  run,
  coverageById,
  trendById,
  onOpenConcept,
  expanded,
  onToggle,
  onRequestRemove,
}: {
  sectionId: string
  node: SkillTreeNode
  pending: boolean
  run: (action: () => Promise<ActionResult>, onOk?: () => void) => void
  coverageById?: Map<string, SkillIndexNode>
  trendById?: Map<string, number>
  onOpenConcept?: (name: string) => void
  expanded: boolean
  onToggle: (id: string) => void
  onRequestRemove: (node: SkillTreeNode) => void
}) {
  const cov = coverageById?.get(node.id)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  const subs = node.subtopics.length

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div className={cn('tsrow', node.excluded && 'off')}>
        <DragHandle listeners={listeners} />
        {subs > 0 ? (
          <button
            type="button"
            className="tschev"
            aria-expanded={expanded}
            aria-controls={`${SUBS_PREFIX}${node.id}`}
            aria-label={`${expanded ? 'Hide' : 'Show'} the ${subs} ${subs === 1 ? 'subtopic' : 'subtopics'} of ${node.name}`}
            onClick={() => onToggle(node.id)}
          >
            <ChevronRight aria-hidden />
          </button>
        ) : (
          <span className="tschev" aria-hidden />
        )}
        <input
          type="checkbox"
          className="tsck"
          checked={!node.excluded}
          disabled={pending}
          aria-label={node.excluded ? `Include ${node.name}` : `Drop ${node.name}`}
          onChange={() =>
            run(() => setSkillExcluded({ sectionId, skillId: node.id, excluded: !node.excluded }))
          }
        />
        <MasteryValue pct={cov ? cov.masteryPct : null} />
        <MasteryDelta delta={trendById?.get(node.id)} />
        <EditableName
          name={node.name}
          onRename={(name) => run(() => renameSkill({ sectionId, skillId: node.id, name }))}
        />
        {/* what's hidden behind the chevron — the collapsed row still says so */}
        <span className="tssub">
          {subs > 0 && !expanded ? `${subs} ${subs === 1 ? 'subtopic' : 'subtopics'}` : null}
        </span>
        {cov && (
          <button
            type="button"
            onClick={() => onOpenConcept?.(node.name)}
            className="tscov"
            title="Open concept detail — assessed by, taught in, mastery"
          >
            <CoverageBadges node={cov} />
          </button>
        )}
        <button type="button" className="tsdel" aria-label={`Remove ${node.name}`} onClick={() => onRequestRemove(node)}>
          <Trash2 aria-hidden />
        </button>
      </div>

      {/* Mounted only while open — the whole point of the collapse. Shares the
          tree's single DndContext; this SortableContext's id routes the drop. */}
      {subs > 0 && expanded && (
        <div id={`${SUBS_PREFIX}${node.id}`} className="tssubs">
          <SortableContext id={`${SUBS_PREFIX}${node.id}`} items={node.subtopics.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {node.subtopics.map((sub) => (
              <SubskillRow key={sub.id} sectionId={sectionId} sub={sub} pending={pending} run={run} coverageById={coverageById} trendById={trendById} onOpenConcept={onOpenConcept} />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  )
})

// ── In-drawer remove confirm (see header comment: never a portal) ──

function RemoveConfirmCard({
  node,
  pending,
  onCancel,
  onConfirm,
}: {
  node: SkillTreeNode
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  /* Same focus/Escape contract as the mastery-settings card: focus in on
     open, Escape (captured) closes this card only — the drawer's own
     bubble-phase Escape handler never sees it. */
  useEffect(() => {
    cardRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const subs = node.subtopics.length
  return (
    <div className="tsset">
      <div className="catch" aria-hidden onClick={onCancel} />
      <div ref={cardRef} tabIndex={-1} className="card" role="alertdialog" aria-modal="true" aria-label={`Remove ${node.name}?`} onKeyDown={trapTab}>
        <span className="akick">REMOVE SKILL</span>
        <span className="atitle">Remove “{node.name}”?</span>
        <p className="intro">
          {subs > 0
            ? `This also removes its ${subs} ${subs === 1 ? 'subtopic' : 'subtopics'}. To stop tracking it instead, just uncheck it. This can’t be undone.`
            : 'To stop tracking it instead, just uncheck it. This can’t be undone.'}
        </p>
        <div className="foot">
          <button type="button" className="tsbtn ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <button type="button" className="tsbtn danger" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sortable subtopic row ───────────────────────────────────────

const SubskillRow = memo(function SubskillRow({
  sectionId,
  sub,
  pending,
  run,
  coverageById,
  trendById,
  onOpenConcept,
}: {
  sectionId: string
  sub: SkillRow
  pending: boolean
  run: (action: () => Promise<ActionResult>, onOk?: () => void) => void
  coverageById?: Map<string, SkillIndexNode>
  trendById?: Map<string, number>
  onOpenConcept?: (name: string) => void
}) {
  const cov = coverageById?.get(sub.id)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sub.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={cn('tsrow sub', sub.excluded && 'off')}
    >
      <DragHandle listeners={listeners} />
      <input
        type="checkbox"
        className="tsck"
        checked={!sub.excluded}
        disabled={pending}
        aria-label={sub.excluded ? `Include ${sub.name}` : `Drop ${sub.name}`}
        onChange={() =>
          run(() => setSkillExcluded({ sectionId, skillId: sub.id, excluded: !sub.excluded }))
        }
      />
      <MasteryValue pct={cov ? cov.masteryPct : null} />
      <MasteryDelta delta={trendById?.get(sub.id)} />
      <EditableName
        name={sub.name}
        grow
        onRename={(name) => run(() => renameSkill({ sectionId, skillId: sub.id, name }))}
      />
      {cov && (
        <button
          type="button"
          onClick={() => onOpenConcept?.(sub.name)}
          className="tscov"
          title="Open concept detail — assessed by, taught in, mastery"
        >
          <CoverageBadges node={cov} />
        </button>
      )}
      <button
        type="button"
        className="tsdel"
        aria-label="Remove subtopic"
        onClick={() => run(() => deleteSkill({ sectionId, skillId: sub.id }))}
      >
        <Trash2 aria-hidden />
      </button>
    </div>
  )
})

// ── Inline-editable name ────────────────────────────────────────

function EditableName({
  name,
  grow,
  onRename,
}: {
  name: string
  /** Stretch to fill the row (subtopic rows have no trailing count). */
  grow?: boolean
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)

  function commit() {
    const next = value.trim()
    setEditing(false)
    if (next && next !== name) onRename(next)
    else setValue(name)
  }

  if (editing) {
    return (
      <span className="tsedit" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setValue(name)
              setEditing(false)
            }
          }}
          maxLength={120}
        />
        <button type="button" className="tsdel" style={{ opacity: 1 }} aria-label="Save" onClick={commit}>
          <Check aria-hidden />
        </button>
        <button
          type="button"
          className="tsdel"
          style={{ opacity: 1 }}
          aria-label="Cancel"
          onClick={() => {
            setValue(name)
            setEditing(false)
          }}
        >
          <X aria-hidden />
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      className="tsname"
      style={grow ? { flex: 1 } : undefined}
      onClick={() => {
        setValue(name)
        setEditing(true)
      }}
      aria-label={`Rename ${name}`}
    >
      <span className="nm">{name}</span>
      <Pencil aria-hidden />
    </button>
  )
}
