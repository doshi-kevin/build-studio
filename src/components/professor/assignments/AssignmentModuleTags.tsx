/**
 * AssignmentModuleTags — the compulsory "Modules" field that sits right above the rubric.
 * Tags the assignment with one or more modules (settings.skillModules): those modules'
 * skill pool is where per-question rubric skill tags come from, and the FIRST tagged
 * module is the assignment's roadmap placement at publish. Self-contained: loads its own
 * state, persists on every toggle, and reports the current tagging state up to its host
 * so the RubricEditor can gate generation/save and offer the skill options.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu'
import {
  getAssignmentSkillTagging,
  saveAssignmentSkillModules,
} from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'

export interface SkillTaggingState {
  /** Still loading the initial state. */
  loading: boolean
  /** Section has modules, so tagging is compulsory. */
  required: boolean
  /** Currently tagged module ids (the first one is the roadmap placement). */
  moduleIds: string[]
  /** Skill pool of the tagged modules: the per-question tag options. */
  skillOptions: { id: string; name: string }[]
}

interface ModuleOption {
  id: string
  title: string
  weekNumber: number | null
}

export function AssignmentModuleTags({
  sectionId,
  assignmentId,
  onStateChange,
}: {
  sectionId: string
  assignmentId: string
  /** Fired with the full tagging state on load and after every change. Pass a stable setter. */
  onStateChange?: (state: SkillTaggingState) => void
}) {
  const [modules, setModules] = useState<ModuleOption[] | null>(null)
  const [tagged, setTagged] = useState<string[]>([])
  const [skillOptions, setSkillOptions] = useState<{ id: string; name: string }[]>([])
  // In-flight toggle saves (a count, not a flag: rapid ticks overlap). Saves are
  // serialized through saveChainRef below, so this only drives quiet UI states.
  const [pendingSaves, setPendingSaves] = useState(0)
  // The current tags, readable synchronously (toggle can fire twice between renders).
  const taggedRef = useRef<string[]>([])
  // Serialized save chain + latest-wins bookkeeping (see toggle()).
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const saveSeqRef = useRef(0)
  // The last tag list the SERVER confirmed — what a failed save reverts to.
  const lastConfirmedRef = useRef<string[]>([])

  useEffect(() => {
    let alive = true
    getAssignmentSkillTagging(sectionId, assignmentId).then((res) => {
      if (!alive) return
      if ('error' in res) {
        setModules([])
        toast.error(res.error)
        return
      }
      setModules(res.modules)
      setTagged(res.taggedIds)
      taggedRef.current = res.taggedIds
      lastConfirmedRef.current = res.taggedIds
      setSkillOptions(res.skillOptions)
    })
    return () => {
      alive = false
    }
  }, [sectionId, assignmentId])

  // Lift the full tagging state whenever any piece of it changes.
  useEffect(() => {
    onStateChange?.({
      loading: modules === null,
      required: (modules?.length ?? 0) > 0,
      moduleIds: tagged,
      skillOptions,
    })
  }, [modules, tagged, skillOptions, onStateChange])

  // Every toggle persists, serialized in click order — a tick made while the previous
  // save is still in flight is QUEUED, never silently dropped (#553: `if (saving) return`
  // discarded rapid second clicks with no chip, no error). Latest-wins: only the newest
  // save's response updates skillOptions or reports an error; a failed latest save
  // reverts to the last server-confirmed tags. `.catch` on every link so one rejected
  // save can never poison the chain for later toggles.
  function toggle(moduleId: string) {
    const cur = taggedRef.current
    const next = cur.includes(moduleId) ? cur.filter((id) => id !== moduleId) : [...cur, moduleId]
    taggedRef.current = next
    setTagged(next) // optimistic; a failed LATEST save reverts to lastConfirmedRef
    const seq = ++saveSeqRef.current
    setPendingSaves((n) => n + 1)
    saveChainRef.current = saveChainRef.current
      .then(() => saveAssignmentSkillModules(sectionId, assignmentId, next))
      .then((res) => {
        // Any successful write moves the server-confirmed baseline, even a superseded
        // one — a later failed save must revert to what the server actually has.
        if (!('error' in res)) lastConfirmedRef.current = next
        if (seq !== saveSeqRef.current) return // superseded: the newest save settles the UI
        if ('error' in res) {
          taggedRef.current = lastConfirmedRef.current
          setTagged(lastConfirmedRef.current)
          toast.error(res.error)
          return
        }
        setSkillOptions(res.skillOptions)
      })
      .catch(() => {}) // server actions return errors, they don't throw; belt-and-braces
      .finally(() => setPendingSaves((n) => n - 1))
  }

  const missing = modules !== null && modules.length > 0 && tagged.length === 0
  // Tagged modules whose topics match no section skills (the pool is honestly empty now,
  // never silently widened to the whole section — #553-1). Quiet while saves are in
  // flight so the message can't flash before the refreshed pool arrives.
  const noLinkedSkills = modules !== null && tagged.length > 0 && skillOptions.length === 0 && pendingSaves === 0

  return (
    // The id is the scroll target for the locked RubricEditor's "tag a module" hint.
    <div id="assignment-module-tags" className="space-y-2 scroll-mt-24">
      <div className="flex items-baseline gap-2">
        <p className="text-sm font-medium text-foreground">
          Modules <span className="text-destructive">*</span>
        </p>
        <span className="text-xs text-muted-foreground">
          {skillOptions.length > 0 && `${skillOptions.length} ${skillOptions.length === 1 ? 'skill' : 'skills'} available for tagging`}
        </span>
      </div>

      {modules === null ? (
        <p className="text-xs text-muted-foreground">Loading modules…</p>
      ) : modules.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No modules in this section yet, so skill tagging is off for this assignment.
        </p>
      ) : (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="w-full max-w-md justify-between font-normal"
              >
                <span className={`truncate ${tagged.length === 0 ? 'text-muted-foreground' : ''}`}>
                  {tagged.length === 0
                    ? 'Tag one or more modules…'
                    : `${tagged.length} ${tagged.length === 1 ? 'module' : 'modules'} tagged`}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-(--radix-dropdown-menu-trigger-width) overflow-y-auto">
              {modules.map((m) => (
                <DropdownMenuCheckboxItem
                  key={m.id}
                  checked={tagged.includes(m.id)}
                  onCheckedChange={() => toggle(m.id)}
                  // Keep the menu open while ticking several modules.
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="truncate">
                    {m.weekNumber ? `Week ${m.weekNumber} · ` : ''}
                    {m.title}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Tagged modules as removable bubbles, in tag order (the first is the roadmap placement). */}
          {tagged.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tagged.map((id) => {
                const m = modules.find((mod) => mod.id === id)
                if (!m) return null
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                  >
                    {m.weekNumber ? `Week ${m.weekNumber} · ` : ''}
                    {m.title}
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      aria-label={`Remove module ${m.title}`}
                      className="-m-0.5 rounded-full p-0.5 transition-colors hover:bg-primary/20"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )
              })}
            </div>
          )}
          <p className={`text-xs ${missing ? 'text-destructive' : 'text-muted-foreground'}`}>
            {missing
              ? 'Required: tag at least one module before generating or saving the rubric.'
              : noLinkedSkills
                ? 'No skills are linked to these modules yet. Once you add and process materials in these modules, their skills will appear here for tagging.'
                : 'Rubric skills are tagged from these modules, and the assignment appears under the first tagged module on the roadmap.'}
          </p>
        </>
      )}
    </div>
  )
}
