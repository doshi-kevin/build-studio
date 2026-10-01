/**
 * AssignmentAthenaDock — the ONE generalized Athena for the whole assignments
 * feature (Colab-Gemini style): a floating button that opens a full-height right
 * side panel, mounted once at the assignments layout so it's available on every
 * assignments page (list, new, detail, grading, studio, verbal).
 *
 * It is CONTEXT-AWARE by registration, not by placement. Whatever screen is
 * active registers what Athena can act on via useAthenaSurface({ surface,
 * assignmentId, getScreen, onFill }); the dock wires the chat to the most-recent
 * registration. Nothing registered → a general brainstorm state. This is what
 * makes it generalized AND able to drive the specific screen — and it's how a
 * future assignment template plugs in (it just registers its own surface).
 *
 * The panel content is the reusable AssignmentAthenaPanel; the dock only owns
 * open/close, the slide-in chrome, and the content push.
 *
 * Type: Client Component
 */
'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  AssignmentAthenaPanel,
  type AthenaPendingPrompt,
  type AttachResult,
  type FillResult,
} from './AssignmentAthenaPanel'
import type {
  AssignmentAssistantMode,
  AssignmentAssistantSurface,
  AssignmentFillTool,
  AssignmentScreen,
} from '@/lib/ai/assignment-assistant/schemas'
import { DEFAULT_ASSIGNMENT_ASSISTANT_MODE } from '@/lib/ai/assignment-assistant/schemas'
import type { AssignmentRubric } from '@/lib/validations/assignment'
import type { UIMessage } from 'ai'

export type { AthenaPendingPrompt, AttachResult, FillResult }

/** What a screen registers so Athena can read + drive it. */
interface SurfaceRegistration {
  surface: AssignmentAssistantSurface
  /** Authoring mode: which template kind this editor is (files/notebook/verbal/document/…). */
  kind?: string
  assignmentId?: string
  getScreen: () => AssignmentScreen
  onFill: (tool: AssignmentFillTool, payload: unknown) => FillResult
  /** Optional: this screen handles file attachment itself (see AttachResult). */
  onAttach?: (file: File) => Promise<AttachResult>
  /**
   * Optional: this screen holds the rubric in its OWN state, so tell it when Athena writes
   * one. Without this the studio keeps a `useState(initialRubric)` seeded at mount, its
   * rubric pane renders empty after a Frontier save, and a professor who then adds their own
   * question replaces Athena's — a silent data loss QA reproduced. router.refresh() cannot
   * fix that: the component never remounts, so the refreshed prop is ignored.
   */
  onRubricSaved?: (rubric: AssignmentRubric | null) => void
}

/**
 * What a collapsed trigger should signal about the chat:
 *  - 'working'  → the chat is generating right now (amber, pulsing)
 *  - 'unseen'   → it finished something while collapsed, not yet viewed (green)
 *  - 'idle'     → nothing to show (also always 'idle' while the dock is open)
 */
export type AthenaActivity = 'idle' | 'working' | 'unseen'

interface AthenaDockContext {
  /**
   * False when the institution does not have Athena in its plan. The ask line
   * renders nothing rather than inviting a professor into a request the API
   * will refuse. Distinct from the AI kill switch, which is a temporary safety
   * state and DOES still show the bar with a policy message.
   */
  entitled: boolean
  open: boolean
  setOpen: (open: boolean) => void
  /** Open the dock AND send `text` as the next chat turn (see AthenaPendingPrompt). */
  ask: (text: string) => void
  /** Post a note into the chat from ANY screen under the provider (see useAthenaNotify). */
  notify: (text: string) => void
  /** The panel registers its own note-poster here on mount. */
  setNotifier: (fn: ((text: string) => void) | null) => void
  activity: AthenaActivity
  /** The panel reports its busy→settled edge here; the provider derives `activity`. */
  onActivity: (kind: 'working' | 'done') => void
  register: (key: string, reg: SurfaceRegistration) => void
  unregister: (key: string) => void
  /** Ask-line singleton claim — see useAthenaAskLineSlot. */
  claimAskLine: (key: string) => void
  releaseAskLine: (key: string) => void
  askLineOwner: string | null
  /** Whether any surface is currently registered — false on a list page. */
  hasHost: boolean
  /** Frontier mode. Lives HERE rather than in the panel because it is part of panelKey:
   *  flipping it must remount the panel with a fresh conversation (see panelKey below). */
  mode: AssignmentAssistantMode
  setMode: (mode: AssignmentAssistantMode) => void
}

const DockCtx = createContext<AthenaDockContext | null>(null)

/**
 * Open/close the dock from anywhere under the provider, plus the collapsed
 * activity signal so any external trigger (FAB, a toolbar button) can show it.
 */
export function useAthenaDock(): {
  open: boolean
  setOpen: (open: boolean) => void
  ask: (text: string) => void
  activity: AthenaActivity
  mode: AssignmentAssistantMode
  setMode: (mode: AssignmentAssistantMode) => void
  /** False on a surface where no editor registered — drives honest copy. */
  hasHost: boolean
  /** False when the school does not have Athena; the ask line renders nothing. */
  entitled: boolean
} {
  const ctx = useContext(DockCtx)
  return useMemo(
    () => ({
      open: ctx?.open ?? false,
      setOpen: ctx?.setOpen ?? (() => {}),
      ask: ctx?.ask ?? (() => {}),
      activity: ctx?.activity ?? 'idle',
      mode: ctx?.mode ?? DEFAULT_ASSIGNMENT_ASSISTANT_MODE,
      setMode: ctx?.setMode ?? (() => {}),
      hasHost: ctx?.hasHost ?? true,
      // Defaults TRUE with no provider, matching every other field here: the
      // absence of a dock must not read as "this school lost Athena".
      entitled: ctx?.entitled ?? true,
    }),
    [ctx?.open, ctx?.setOpen, ctx?.ask, ctx?.activity, ctx?.mode, ctx?.setMode, ctx?.hasHost, ctx?.entitled],
  )
}

/**
 * Post a note into Athena's chat from the host screen — used when something finishes
 * OUTSIDE a conversation turn and she would otherwise never learn about it (a generation
 * run settling, for instance: without this she keeps saying "as soon as the run finishes"
 * forever, because nothing pulls a fresh screen until the professor speaks again).
 *
 * CONTRACT: pass only APP-AUTHORED text — your own copy, counts, or a filename the
 * professor themselves chose. The note lands as an assistant turn, so it is echoed back to
 * the model as something Athena said, i.e. as trusted. Never route student- or
 * third-party-supplied content through here; that has to go in wrapped as untrusted data
 * the way summarize_submission does it.
 */
export function useAthenaNotify(): (text: string) => void {
  const ctx = useContext(DockCtx)
  return useMemo(() => ctx?.notify ?? (() => {}), [ctx?.notify])
}

/**
 * Claim the single ask-line slot. Returns true for the ONE instance allowed to render.
 *
 * Nesting is legitimate — a page mounts one and a child panel mounts another without either
 * knowing — so the guard lives here rather than asking every host to coordinate. It also
 * means a new surface can mount an ask line freely and never create a duplicate.
 */
export function useAthenaAskLineSlot(): boolean {
  const ctx = useContext(DockCtx)
  const key = useId()
  const claim = ctx?.claimAskLine
  const release = ctx?.releaseAskLine
  useEffect(() => {
    if (!claim || !release) return
    claim(key)
    return () => release(key)
  }, [claim, release, key])
  // With no provider there is nothing to duplicate — render, so a stray usage still shows.
  if (!ctx) return true
  return ctx.askLineOwner === null || ctx.askLineOwner === key
}

/**
 * The collapsed-activity dot shown on a trigger button. Purely decorative
 * (aria-hidden) — the trigger's aria-label carries the state for AT. Amber
 * pulses while Athena works; green is a finished-but-unseen result.
 */
export function AthenaActivityDot({ activity, className }: { activity: AthenaActivity; className?: string }) {
  if (activity === 'idle') return null
  const working = activity === 'working'
  return (
    <span aria-hidden="true" className={`pointer-events-none absolute ${className ?? '-right-0.5 -top-0.5'}`}>
      <span className="relative flex h-2.5 w-2.5">
        {working && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75 motion-reduce:animate-none" />
        )}
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-card ${working ? 'bg-warning' : 'bg-success'}`}
        />
      </span>
    </span>
  )
}

/**
 * Register the current screen as Athena's active surface while `active` is true.
 * Callbacks are read through a ref so they never need to be effect deps (no
 * re-register churn on every keystroke); only surface/assignmentId/active do.
 */
export function useAthenaSurface(args: {
  active: boolean
  surface: AssignmentAssistantSurface
  kind?: string
  assignmentId?: string
  getScreen: () => AssignmentScreen
  onFill: (tool: AssignmentFillTool, payload: unknown) => FillResult
  onAttach?: (file: File) => Promise<AttachResult>
  onRubricSaved?: (rubric: AssignmentRubric | null) => void
}): void {
  const ctx = useContext(DockCtx)
  const key = useId()
  const register = ctx?.register
  const unregister = ctx?.unregister
  const { active, surface, kind, assignmentId, getScreen, onFill, onAttach, onRubricSaved } = args

  const cbRef = useRef({ getScreen, onFill, onAttach, onRubricSaved })
  useEffect(() => {
    cbRef.current = { getScreen, onFill, onAttach, onRubricSaved }
  })

  // `hasAttach` (not onAttach itself) is the dep: a host that recreates the callback each
  // render must not churn the registration, but appearing/disappearing must re-register.
  const hasAttach = !!onAttach
  useEffect(() => {
    if (!register || !unregister || !active) return
    register(key, {
      surface,
      kind,
      assignmentId,
      getScreen: () => cbRef.current.getScreen(),
      onFill: (t, p) => cbRef.current.onFill(t, p),
      onAttach: hasAttach ? (file: File) => cbRef.current.onAttach!(file) : undefined,
      onRubricSaved: (r) => cbRef.current.onRubricSaved?.(r),
    })
    return () => unregister(key)
    // Depend on the STABLE register/unregister callbacks, NOT the whole `ctx` object.
    // The context value is recreated whenever dock state changes (ask-line owner, hasHost),
    // and hasHost derives from the registrations — so depending on `ctx` closed a cycle:
    // register → active changes → ctx changes → register again → "Maximum update depth
    // exceeded". Both callbacks are useCallback-stable, so this re-registers only when the
    // surface genuinely changes.
  }, [register, unregister, active, surface, kind, assignmentId, hasAttach, key])
}

export function AssignmentAthenaProvider({
  sectionId,
  children,
  entitled = true,
}: {
  sectionId: string
  children: ReactNode
  /** Defaults true so every existing mount keeps working untouched. */
  entitled?: boolean
}) {
  const [open, setOpenState] = useState(false)
  // Insertion-ordered map; the active surface is the most-recently registered.
  const [regs, setRegs] = useState<Map<string, SurfaceRegistration>>(() => new Map())

  // ── Collapsed-activity signal ───────────────────────────────────────────
  // The panel reports its useChat status; we turn that into the dot state that
  // any external trigger renders. Refs keep `reportStatus` stable (empty deps)
  // so the panel's status effect never churns.
  const [chatBusy, setChatBusy] = useState(false)
  const [unseen, setUnseen] = useState(false)
  // Frontier mode. Provider-level (not panel state) so it can be part of panelKey; not
  // persisted, because it is a deliberate per-task choice rather than a preference — the
  // professor should never return to a screen and find Athena silently interviewing them.
  const [mode, setMode] = useState<AssignmentAssistantMode>(DEFAULT_ASSIGNMENT_ASSISTANT_MODE)
  // Which ask line is allowed to render. Two hosts can legitimately both mount one — the
  // assignment detail PAGE and the grader nested inside it did exactly that, producing two
  // fixed bars 16px apart where the upper one was unclickable because the tabs subtree
  // intercepted the pointer. First claim wins; the rest render nothing.
  const [askLineOwner, setAskLineOwner] = useState<string | null>(null)
  const claimAskLine = useCallback((key: string) => {
    setAskLineOwner((cur) => cur ?? key)
  }, [])
  const releaseAskLine = useCallback((key: string) => {
    setAskLineOwner((cur) => (cur === key ? null : cur))
  }, [])
  const openRef = useRef(open)

  // Wrap setOpen so opening clears the "unseen result" flag and keeps openRef in
  // sync — no effect needed (avoids set-state-in-effect churn).
  const setOpen = useCallback((next: boolean) => {
    openRef.current = next
    setOpenState(next)
    if (next) setUnseen(false)
  }, [])

  // The panel detects its own busy→settled edge (a ref-in-effect there) and
  // reports discrete events; we only flip state here, never in an effect.
  const onActivity = useCallback((kind: 'working' | 'done') => {
    if (kind === 'working') {
      setChatBusy(true)
    } else {
      setChatBusy(false)
      if (!openRef.current) setUnseen(true) // settled while collapsed ⇒ unseen result
    }
  }, [])

  // The panel owns the chat transcript, so it registers its poster here and the provider
  // just forwards. A note that arrives while no panel is mounted is dropped on purpose —
  // it would have nowhere to render.
  const notifierRef = useRef<((text: string) => void) | null>(null)
  const setNotifier = useCallback((fn: ((text: string) => void) | null) => {
    // A null clear is IGNORED on purpose. On a panel remount (the key changes when the
    // professor switches quiz or surface) React may run the old panel's cleanup AFTER the
    // new panel's setup, so honouring its null would wipe the live poster and silence
    // every later note. The next mount overwrites this ref anyway, and a note delivered to
    // a torn-down panel is a harmless no-op (setMessages on an unmounted tree does
    // nothing) — so "last mount wins" is both simpler and strictly safer than clearing.
    if (fn) notifierRef.current = fn
  }, [])
  const notify = useCallback((text: string) => {
    notifierRef.current?.(text)
    // Same signal a finished chat turn gives: if the dock is shut, mark it unseen so the
    // trigger's dot tells the professor something happened. Without this a run could
    // finish, and fall short, with nothing on screen saying so.
    if (!openRef.current) setUnseen(true)
  }, [])

  // ── The ask line's prompt hand-off ──────────────────────────────────────
  // Opening and queueing are one gesture. The panel consumes this and calls
  // clearPendingPrompt; until it does, the prompt survives a panel remount.
  const [pendingPrompt, setPendingPrompt] = useState<AthenaPendingPrompt | null>(null)
  const ask = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      setOpen(true)
      if (trimmed) setPendingPrompt({ id: crypto.randomUUID(), text: trimmed })
    },
    [setOpen],
  )
  const clearPendingPrompt = useCallback(() => setPendingPrompt(null), [])

  const register = useCallback((key: string, reg: SurfaceRegistration) => {
    setRegs((prev) => {
      const next = new Map(prev)
      next.delete(key) // re-insert so this becomes the most recent
      next.set(key, reg)
      return next
    })
  }, [])
  const unregister = useCallback((key: string) => {
    setRegs((prev) => {
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }, [])

  const derivedActive = useMemo(() => {
    let last: SurfaceRegistration | null = null
    for (const r of regs.values()) last = r
    return last
  }, [regs])
  // Retain the last real surface across a TRANSIENT empty-registration gap. Navigating INTO
  // a freshly-created assignment (e.g. New → Verbal → its editor) unregisters the old screen
  // a beat before the new one registers; without this, `active` would blink to null, the
  // panelKey would flip to 'general' and back, remounting the panel and wiping an in-progress
  // chat. A genuine new surface (different assignment/mode) still registers and changes the
  // key normally.
  // "Adjust state during render" (same pattern as prevPanelKey below) — lint-clean and
  // updates synchronously so `active` is correct on the very next render, no effect lag.
  const [lastReal, setLastReal] = useState<SurfaceRegistration | null>(derivedActive)
  if (derivedActive && derivedActive !== lastReal) setLastReal(derivedActive)
  const active = derivedActive ?? lastReal

  // …but the retention must EXPIRE, or it outlives the screen it points at. The gap above is
  // measured in a frame or two; anything longer is a real navigation away (studio → quiz
  // list), and holding the departed editor's registration means a fill would call getScreen /
  // onFill on callbacks captured by an unmounted component. Previously this was avoided by
  // mounting the provider per-page so the whole dock died on exit — which is also why the
  // quizzes LIST had no Athena at all. Expiring the retention is what makes a longer-lived
  // provider safe: after the grace window `active` goes null, and the dock's no-host fallback
  // reports applied:false rather than writing into a ghost.
  useEffect(() => {
    if (derivedActive) return
    const t = setTimeout(() => setLastReal(null), 400)
    return () => clearTimeout(t)
  }, [derivedActive])

  // Stable getScreen/onFill wrappers that read the latest active registration.
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])
  // `active` keeps the RETAINED registration for 400ms so panelKey doesn't blink during a
  // navigation. Execution must NOT use that: inside the window the editor is already
  // unmounted, so a fill resolving there would call callbacks on a dead component and still
  // report applied:true — Athena announces a change that went nowhere. So the wrappers below
  // read `derivedActive` (the live one) and fail closed when there is none.
  const derivedActiveRef = useRef(derivedActive)
  useEffect(() => {
    derivedActiveRef.current = derivedActive
  })

  // getScreen may safely use the retained value — a slightly stale screen is better context
  // than none, and it is read-only.
  const getScreen = useCallback((): AssignmentScreen => activeRef.current?.getScreen() ?? {}, [])
  const onFill = useCallback(
    (tool: AssignmentFillTool, payload: unknown): FillResult =>
      derivedActiveRef.current?.onFill(tool, payload) ?? {
        summary: 'There is no editor open on screen to write that into.',
        applied: false,
      },
    [],
  )
  // Only forwarded when the active screen actually registered one, so the panel keeps its
  // own assignment-attachment path everywhere else.
  // Stable, reads the live registration — so a rubric written by Athena lands in whichever
  // studio is mounted, and does nothing (harmlessly) on a surface that owns no rubric state.
  const onRubricSaved = useCallback((r: AssignmentRubric | null) => {
    derivedActiveRef.current?.onRubricSaved?.(r)
  }, [])

  const hasHostAttach = !!active?.onAttach
  const onAttach = useCallback(
    (file: File): Promise<AttachResult> =>
      activeRef.current?.onAttach?.(file) ?? Promise.resolve({ error: 'There is nowhere to put that file right now.' }),
    [],
  )

  // No dot while open; else amber (working) beats green (unseen result).
  const activity: AthenaActivity = open ? 'idle' : chatBusy ? 'working' : unseen ? 'unseen' : 'idle'

  const ctxValue = useMemo<AthenaDockContext>(
    () => ({ entitled, open, setOpen, ask, activity, onActivity, register, unregister, notify, setNotifier, mode, setMode, claimAskLine, releaseAskLine, askLineOwner, hasHost: !!active }),
    [entitled, open, setOpen, ask, activity, onActivity, register, unregister, notify, setNotifier, mode, setMode, claimAskLine, releaseAskLine, askLineOwner, active],
  )

  // Reset the chat when the active surface changes (create ↔ grade, or a
  // different assignment) so context never bleeds across tasks.
  //
  // `mode` is part of the key ON PURPOSE. Frontier changes Athena's whole cadence — it asks
  // questions before building — so a transcript that is half standard and half Frontier
  // would be a prompt arguing with its own history. Flipping the toggle therefore starts a
  // fresh conversation, which is also what the professor means by switching mode.
  const baseKey = `${mode}:${active?.surface ?? 'general'}:${active?.kind ?? ''}:${active?.assignmentId ?? ''}`

  // An explicit "New chat" or "Resume" bumps the epoch for ONE baseKey, which remounts
  // the panel (the epoch rides inside panelKey below) without touching any OTHER
  // scope's in-progress conversation. Plain navigation between assignments never
  // bumps anything — every baseKey starts at epoch 0 and stays there until the
  // professor explicitly asks for a different thread.
  const [epochs, setEpochs] = useState<Record<string, number>>({})
  const panelKey = `${epochs[baseKey] ?? 0}:${baseKey}`

  // One transcript per panelKey, so flipping Frontier (or resuming a saved thread)
  // SWAPS conversations rather than destroying one. Keeping mode in panelKey is
  // still what stops a half-standard, half-Frontier history reaching the model —
  // this just means the half you leave is waiting when you come back. Keyed by the
  // full panelKey (not only mode) so a different assignment never restores the
  // wrong conversation. A ref: purely a cache, and writing it must not re-render
  // the provider (which would re-register every surface).
  // Both accessors are CALLBACKS bound to the current key, never ref reads during render
  // (which the hooks lint correctly rejects). The panel calls the getter from its mount
  // effect, so the cache is only ever touched during an effect or an event.
  const transcripts = useRef<Map<string, UIMessage[]>>(new Map())
  const getStoredMessages = useCallback(() => transcripts.current.get(panelKey), [panelKey])
  const rememberMessages = useCallback(
    (messages: UIMessage[]) => {
      transcripts.current.set(panelKey, messages)
    },
    [panelKey],
  )

  // One conversation id per panelKey, mirroring transcripts above — lets the panel
  // stop minting its own crypto.randomUUID() on every mount and instead persist a
  // STABLE id across re-registrations of the same scope (a plain navigation), while
  // still getting a fresh one whenever the epoch bumps (New chat) or a different
  // saved id is seeded in (Resume). Generated lazily on first ask, exactly once per
  // key, so a bare mount with no explicit New/Resume action behaves exactly like
  // today's per-mount random id.
  const conversationIds = useRef<Map<string, string>>(new Map())
  const getInitialConversationId = useCallback(() => {
    const existing = conversationIds.current.get(panelKey)
    if (existing) return existing
    const fresh = crypto.randomUUID()
    conversationIds.current.set(panelKey, fresh)
    return fresh
  }, [panelKey])

  /** Start a blank thread in the CURRENT mode for the current scope — the panel's
   *  "New chat" button. Seeds the target panelKey's conversation id up front (rather
   *  than relying on the lazy default above) so the intent reads the same way
   *  resumeConversation's seeding does. */
  const startNewChat = useCallback(() => {
    const nextEpoch = (epochs[baseKey] ?? 0) + 1
    conversationIds.current.set(`${nextEpoch}:${baseKey}`, crypto.randomUUID())
    setEpochs((prev) => ({ ...prev, [baseKey]: nextEpoch }))
  }, [epochs, baseKey])

  /** Replace the current session with a saved one — the resume dropdown's click
   *  handler. `mode` here is the RESUMED thread's own mode, which can differ from
   *  the panel's current mode; when it does, both the epoch bump and setMode
   *  fire together so the remount lands on the exact panelKey we just seeded,
   *  never a half-updated one. */
  const resumeConversation = useCallback(
    (resumed: { mode: AssignmentAssistantMode; conversationId: string; messages: UIMessage[] }) => {
      const targetBaseKey = `${resumed.mode}:${active?.surface ?? 'general'}:${active?.kind ?? ''}:${active?.assignmentId ?? ''}`
      const nextEpoch = (epochs[targetBaseKey] ?? 0) + 1
      const targetPanelKey = `${nextEpoch}:${targetBaseKey}`
      conversationIds.current.set(targetPanelKey, resumed.conversationId)
      transcripts.current.set(targetPanelKey, resumed.messages)
      setEpochs((prev) => ({ ...prev, [targetBaseKey]: nextEpoch }))
      if (resumed.mode !== mode) setMode(resumed.mode)
    },
    [epochs, active, mode, setMode],
  )

  // A remount is a fresh conversation — drop any carried-over activity signal.
  // React's "adjust state during render on prop change" pattern (no effect).
  const [prevPanelKey, setPrevPanelKey] = useState(panelKey)
  if (panelKey !== prevPanelKey) {
    setPrevPanelKey(panelKey)
    setChatBusy(false)
    setUnseen(false)
    // A parked prompt belongs to the conversation it was typed into. Without this it
    // outlives the remount — a prompt deferred while Athena was mid-answer on one
    // assignment would fire into the NEXT one the professor opens, against a different
    // screen, and the panel applies fill tools automatically (some irreversibly).
    setPendingPrompt(null)
  }

  // Escape closes the dock. On mobile the panel is a full-screen overlay covering the very
  // trigger that opened it, so a keyboard/AT user otherwise has only the header button —
  // and Escape-dismisses-an-overlay is near-universal expectation on desktop too. The
  // focus-restore effect below then puts focus back on the trigger. A modal dialog layered
  // above (the settings drawer) handles its own Escape first, on its own layer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // Restore focus to the trigger when the dock closes — otherwise focus falls to <body>
  // once the panel goes `inert` (WCAG 2.4.3). Focus-only effect (no state) → lint-clean.
  const prevOpenRef = useRef(open)
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      document.querySelector<HTMLElement>('[data-athena-trigger]')?.focus()
    }
    prevOpenRef.current = open
  }, [open])

  return (
    <DockCtx.Provider value={ctxValue}>
      {/* Athena's activity, announced. This lives on the PROVIDER, not on the ask line:
          the bar goes `inert` while the dock is open (which would drop a live region
          inside it out of the a11y tree) and isn't mounted at all on the surfaces that
          gate Athena off. Sighted users get the same signal from AthenaActivityDot. */}
      <span role="status" aria-live="polite" className="sr-only">
        {activity === 'working' ? 'Athena is working…' : activity === 'unseen' ? 'Athena has a new response' : ''}
      </span>

      {/* Content pushes left when the panel is open (desktop); panel overlays on mobile.
          The trigger is the floating AthenaAskLine, mounted by each surface (so a studio
          can gate it off while previewing) — not by this provider. */}
      {/* pb-24 below md reserves the lane the floating AthenaAskLine occupies (48px up,
          44px tall). Without it a fixed bar sits ON TOP of whatever control happens to be
          at the bottom of the page — QA caught it swallowing taps meant for
          "+ Add question". Desktop needs none: the bar clears content there. */}
      <div className={`pb-24 transition-[padding] duration-200 md:pb-0 ${open ? 'md:pr-[var(--athena-dock-w)]' : ''}`}>
        {children}
      </div>

      {/* Slide-in side panel. z-[55] sits above the app's z-50 Feedback pill so it
          doesn't cover the composer. data-athena-dock lets a non-modal dialog stay
          open when the professor clicks into Athena (see CreateAssignmentWizard). */}
      <aside
        data-athena-dock
        aria-hidden={!open}
        // Closed panel is off-screen but its composer/buttons would stay in the
        // tab order on every assignments page; `inert` removes the whole subtree
        // from keyboard focus + the a11y tree while hidden.
        inert={!open}
        // `top` follows --athena-dock-top so the panel starts *below* a studio header (which
        // publishes its height) and stays full-height (var defaults to 0) everywhere else.
        // Width follows main's resizable --athena-dock-w variable.
        style={{ top: 'var(--athena-dock-top, 0px)' }}
        className={`fixed bottom-0 right-0 z-[55] flex w-full flex-col border-l border-border bg-card shadow-xl transition-transform duration-200 md:w-[var(--athena-dock-w)] ${
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full'
        }`}
      >
        <AssignmentAthenaPanel
          key={panelKey}
          sectionId={sectionId}
          surface={active?.surface ?? 'authoring'}
          kind={active?.kind}
          assignmentId={active?.assignmentId}
          mode={mode}
          onModeChange={setMode}
          open={open}
          getScreen={getScreen}
          onFill={onFill}
          onAttach={hasHostAttach ? onAttach : undefined}
          onRubricSaved={onRubricSaved}
          hasHost={!!active}
          getInitialMessages={getStoredMessages}
          onMessagesChange={rememberMessages}
          getInitialConversationId={getInitialConversationId}
          onStartNewChat={startNewChat}
          onResumeConversation={resumeConversation}
          onActivity={onActivity}
          onRegisterNotifier={setNotifier}
          pendingPrompt={pendingPrompt}
          onPendingPromptSent={clearPendingPrompt}
          onClose={() => setOpen(false)}
          className="h-full"
        />
      </aside>
    </DockCtx.Provider>
  )
}
