/**
 * AssignmentAthenaPanel — the in-context Athena for assignment screens.
 *
 * A compact docked chat that DRIVES the form it sits beside. Its distinguishing
 * behavior: when the model calls a FILL tool (fill_assignment_form /
 * fill_feedback), this panel writes the values straight into the host form via
 * the `onFill` callback (auto-apply), then resolves the tool so the model
 * acknowledges. The FORM itself is never persisted here — the professor commits
 * that with the host's own Save/Publish/Grade button. The CONVERSATION is
 * persisted (see /api/assignment-assistant's onFinish + this panel's resume
 * dropdown), independently of whether any fill was ever applied.
 *
 * The host owns the form state; this panel is state-agnostic. It:
 *  - snapshots the current screen via getScreen() at send-time (so Athena edits
 *    surgically and never re-sends stale/heavy context between turns), and
 *  - applies fills via onFill(), which returns a one-line summary + an undo().
 *
 * For a fresh chat (new assignment / different student), the HOST remounts this
 * panel with a React `key` — the conversation id is resolved once per mount
 * (resumed from the dock's cache, or freshly generated), so a remount is a clean
 * slate with no context bleed unless the dock explicitly seeded a resumed one.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from 'ai'
import { CLIENT_RESOLVED_TOOL_TYPES } from '@/lib/ai/assignment-assistant/tool-names'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { isStalledWithoutReply, type TurnMessage } from '@/lib/ai/athena-core/turn-state'
import {
  Bot,
  Send,
  Square,
  Undo2,
  Check,
  Loader2,
  BarChart3,
  FileText,
  ListChecks,
  FolderOpen,
  X,
  Paperclip,
  Globe,
  ExternalLink,
  Compass,
  AlertTriangle,
  ChevronDown,
  CalendarDays,
  Target,
  History,
  SquarePen,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { QuizModuleCard, asModuleCardData } from './QuizModuleCard'
import { AthenaHistoryDrop } from '@/components/shared/athena/AthenaHistoryDrop'
import {
  ASSIGNMENT_FILL_TOOLS,
  PANEL_OWNED_FILL_TOOLS,
  DEFAULT_ASSIGNMENT_ASSISTANT_MODE,
  resolveStudioConversationScope,
  type AssignmentAssistantMode,
  type AssignmentAssistantSurface,
  type AssignmentFillTool,
  type AssignmentScreen,
  type PanelOwnedFillTool,
} from '@/lib/ai/assignment-assistant/schemas'
import {
  applyFrontierRubric,
  saveAssignmentDesign,
  getPanelAthenaUsage,
  listStudioConversations,
  loadStudioConversation,
  setStudioConversationArchivedAction,
} from './actions'
import type { StudioConversationSummary } from '@/lib/ai/assignment-assistant/persistence'
import {
  AthenaUsageNotice,
  ATHENA_USAGE_NOTICE_ID,
} from '@/components/professor/assistant/AthenaUsageNotice'
import { logger } from '@/lib/logger'
import {
  DEFAULT_ATHENA_MODEL_ID,
  failoverCandidates,
  resolveAthenaModelDef,
  type AthenaUsageStatus,
} from '@/lib/ai/professor-assistant/models'
import { acceptAttribute } from '@/lib/ai/athena-attachments'
import { useAthenaAttachments } from '@/lib/hooks/use-athena-attachments'
import { snapshotOf, diffAuthoring, type StateSnapshot } from '@/lib/ai/assignment-assistant/diff'
import type { AssignmentRubric } from '@/lib/validations/assignment'

/** Template kinds whose builder actually has an "Add files & rubrics" step to send
 *  a professor to — the two studios that render SupportingFilesStep AND register a
 *  kind. Pointing anyone else at that step names a thing their screen does not have. */
const KINDS_WITH_FILES_STEP = new Set(['notebook', 'document'])

/** Result of applying a fill to the host form. */
export interface FillResult {
  /** One-line human summary of what changed, e.g. "Set title, points, due date". */
  summary: string
  /**
   * Reverts the fill; omit if not revertible. Rendered as an Undo affordance.
   * Return `false` to REFUSE at click time instead of reverting — a host can decide,
   * the instant this runs, that reverting is no longer safe (About's case: a block
   * this fill touched has since been hand-edited, or the professor already resolved
   * this turn from elsewhere, e.g. Keep on the canvas). Any other return value
   * (including nothing, for every host that predates this) is treated as "it
   * reverted" — see the note at its one call site (handleUndo) for why the
   * difference matters: on `false`, no "Reverted" chip and no synthetic assistant
   * message are posted, because neither happened.
   */
  undo?: () => boolean | void
  /**
   * Dismisses the fill's "recently changed" marker on the host WITHOUT touching content —
   * the fill is already applied and saved either way. Omit if the host has no such marker
   * to clear (most hosts don't); rendered as a "Keep" affordance next to Undo when present.
   */
  keep?: () => void
  /**
   * Whether the fill actually landed on a host form. Defaults to true when
   * omitted, so the real host handlers need no change. The dock's no-host
   * fallback returns false → the model is told the fill did NOT apply (so it
   * relays guidance instead of falsely claiming success) and the chip renders
   * as a plain note with no Undo.
   */
  applied?: boolean
}

/** What a host's own attachment handler reports back. `note` is posted into the chat, so
 *  Athena can then refer to the file (and, on the quiz surface, generate from it). */
export type AttachResult = { name: string; note: string } | { error: string }

/**
 * A prompt typed into the floating ask line, on its way into this chat.
 *
 * The dock carries it as STATE rather than calling a registered callback: this panel
 * remounts whenever the active surface changes, so a callback captured when the
 * professor hit Enter can be stale or already torn down, and the prompt would vanish.
 * Parked in the dock's state it simply waits for whichever panel is mounted to pick it
 * up. The `id` is what makes consuming it exactly-once cheap here.
 */
export interface AthenaPendingPrompt {
  id: string
  text: string
}

interface AssignmentAthenaPanelProps {
  sectionId: string
  surface: AssignmentAssistantSurface
  /** Authoring mode: which template kind (drives copy + the route's apply_edits schema). */
  kind?: string
  /** Grade surface only — the assignment being graded (for feedback grounding). */
  assignmentId?: string
  /** Frontier mode, owned by the dock (it is part of panelKey, so flipping it remounts). */
  mode?: AssignmentAssistantMode
  onModeChange?: (mode: AssignmentAssistantMode) => void
  /** Snapshot the current on-screen state; called at each send. */
  getScreen: () => AssignmentScreen
  /** Apply a fill tool's values to the host form. Returns a summary + optional undo. */
  onFill: (tool: AssignmentFillTool, payload: unknown) => FillResult
  /** Optional: the host takes over file attachment (the quiz studio sends uploads through
   *  the course-materials + module-item path so they become generation sources). */
  onAttach?: (file: File) => Promise<AttachResult>
  /** Tell the host a rubric landed, so a studio holding it in local state re-renders. */
  onRubricSaved?: (rubric: AssignmentRubric | null) => void
  /** False when no editor is registered (a list page) — drives course-level copy. */
  hasHost?: boolean
  /** Fetch the transcript to restore on mount. The dock retains one per panelKey, so flipping
   *  Frontier swaps conversations instead of destroying the one you were in. A getter rather
   *  than a value so the dock never reads its cache during render. */
  getInitialMessages?: () => UIMessage[] | undefined
  /** Report the transcript up so the dock can hand it back after a remount. */
  onMessagesChange?: (messages: UIMessage[]) => void
  /** The conversation id to persist this thread under — the dock hands back a STABLE id per
   *  panelKey (so a plain re-registration keeps the same thread) and a fresh one whenever the
   *  epoch bumps (New chat / Resume). Optional only so a bare render (e.g. in a test) still
   *  works; every real caller is the dock. */
  getInitialConversationId?: () => string
  /** "New chat" — start a blank thread in the current mode for the current scope. */
  onStartNewChat?: () => void
  /** Resume dropdown selection — replaces the current session with a saved one, switching
   *  mode to match if the saved thread was in a different one. */
  onResumeConversation?: (resumed: { mode: AssignmentAssistantMode; conversationId: string; messages: UIMessage[] }) => void
  /** Whether the dock is open — used to move focus into the composer when it opens. */
  open?: boolean
  /** Report the chat's busy→settled edge up so the dock can drive its collapsed activity dot. */
  onActivity?: (kind: 'working' | 'done') => void
  /** Hand the dock this panel's note-poster, so a HOST screen can put a line in the chat
   *  when something finishes outside a conversation turn (see useAthenaNotify). */
  onRegisterNotifier?: (fn: ((text: string) => void) | null) => void
  /** A prompt typed into the ask line, to send as the next turn. Consumed exactly once. */
  pendingPrompt?: AthenaPendingPrompt | null
  /** Tell the dock the pending prompt has been sent, so it stops offering it. */
  onPendingPromptSent?: () => void
  /** Close affordance shown in the header (the dock passes its close handler). */
  onClose?: () => void
  className?: string
}

// Loose shape for a message part (the SDK's union is wide; we read a few fields).
type AnyPart = {
  type?: unknown
  text?: string
  state?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  /** Grounding citation parts ('source-url') carry these. */
  url?: string
  title?: string
}

const READONLY_TOOL_META: Record<string, { icon: typeof BarChart3; running: string; done: string }> = {
  'tool-get_class_struggles': { icon: BarChart3, running: 'Reading what your class struggled with…', done: 'Read class performance' },
  'tool-list_section_assignments': { icon: ListChecks, running: 'Checking your existing assignments…', done: 'Read your assignments' },
  'tool-summarize_submission': { icon: FileText, running: 'Reading the submission…', done: 'Read the submission' },
  'tool-list_modules': { icon: FolderOpen, running: 'Looking through your modules…', done: 'Read your modules' },
  'tool-get_course_data': { icon: CalendarDays, running: 'Reading your real course…', done: 'Read your course' },
  /* Required, not decorative: the read-only branch below does `if (!meta) return null`, so a
     tool absent from this map runs invisibly — no chip, no line, nothing. (#628) */
  'tool-show_outcome_coverage': { icon: Target, running: 'Checking your ABET coverage…', done: 'Read your ABET coverage' },
}

/**
 * True for a Gemini grounding (Google Search) tool part.
 *
 * Matched by PATTERN over BOTH type and toolName, because this is a
 * provider-executed tool and it does NOT arrive shaped like our own tools: the SDK
 * streams it as a DYNAMIC tool part — `type: 'dynamic-tool'` with the real name in
 * `toolName` (observed: 'server:GOOGLE_SEARCH_WEB') — not as 'tool-google_search'.
 * Hence this must be tested BEFORE the `tool-` prefix guard in the renderer, or the
 * part is dropped and a 12-second search looks like a hang. Kept tolerant of the
 * 'tool-google_search' shape too, so a provider change back doesn't re-break it.
 */
function isWebSearchPart(p: AnyPart): boolean {
  const probe = `${typeof p.type === 'string' ? p.type : ''} ${p.toolName ?? ''}`
  return /google.?search|google_search_web/i.test(probe)
}

type GroundingSource = { url: string; title?: string }

/**
 * The turn's Google Search grounding citations, deduped by url.
 *
 * Lifted out of the row component because TWO places need the same list: the search chip
 * (which hides itself when there are sources, so the disclosure below can carry the label
 * instead of stacking two nearly-identical lines) and the disclosure itself.
 *
 * Sources do NOT imply a visible search tool part. Verified against the live API: a grounded
 * turn came back with `steps[0].toolCalls === []` and one source — Gemini executes search
 * provider-side and does not always surface a tool call. So this must never be gated on the
 * presence of a `tool-google_search` part, or citations vanish exactly when only grounding
 * metadata arrived.
 */
function groundingSources(parts: AnyPart[]): GroundingSource[] {
  const seen = new Set<string>()
  return parts
    .filter(
      (p): p is AnyPart & { url: string; title?: string } =>
        p.type === 'source-url' &&
        typeof p.url === 'string' &&
        // ^-anchored, no `m` flag: this is what keeps `javascript:` / `data:` out of the href.
        /^https?:\/\//i.test(p.url) &&
        // The type says `title?: string`, but this is PROVIDER data — asserting a type is not
        // checking one. A non-string title reaches React as a child and an object throws
        // "Objects are not valid as a React child", taking out the whole message list. Same
        // runtime check the url already gets.
        (p.title === undefined || typeof p.title === 'string'),
    )
    .filter((p) => !seen.has(p.url) && seen.add(p.url))
    .map((p) => ({ url: p.url, title: p.title }))
}

// Gemini's grounding chunks carry a vertexaisearch.cloud.google.com REDIRECT uri, not the
// publisher's URL (the link still resolves to the real page, so href is fine). It's only the
// fallback label that matters: with no title we'd print our own machinery, identically for
// every row in the turn — on the feature's trust surface.
const GROUNDING_REDIRECT_HOST = /(^|\.)vertexaisearch\.cloud\.google\.com$/i
function sourceLabel(s: GroundingSource): string {
  if (s.title) return s.title
  try {
    const host = new URL(s.url).hostname.replace(/^www\./, '')
    return GROUNDING_REDIRECT_HOST.test(host) ? 'Web source' : host
  } catch {
    return 'Web source'
  }
}

/**
 * "Searched the web · N sources" as a disclosure.
 *
 * Was a flat pill row under the tool chips, which put the citations on their own line where
 * they read as decoration and got skipped. Collapsed onto the search line they are attached to
 * the claim they support, and the count is visible without expanding — so the professor can see
 * a reply IS sourced at a glance and only opens the list when they want to check one.
 *
 * Native <details> on purpose: no client state to desync, keyboard + screen-reader behaviour for
 * free, and it matches the existing precedent in ZipExplorer. (ui/collapsible.tsx exists but is
 * unused anywhere in the app, so adopting it here would be introducing a pattern, not reusing one.)
 */
function SourcesDisclosure({ sources }: { sources: GroundingSource[] }) {
  if (sources.length === 0) return null
  return (
    <details className="group pt-1">
      {/* min-h-11 below md: this is the ENTRY POINT — nothing inside is reachable until it is
          hit — and at text-xs with no padding it was a 16px target while the links it reveals
          were 44px. Below md the dock is a full-screen sheet, so this is a real thumb surface.
          `-mx-1 px-1 rounded-xl` gives hover and focus a shape instead of hugging the glyphs.
          `::-webkit-details-marker` is a separate pseudo-element from `::marker`, and older
          WebKit/iOS ignores `list-style: none` — globals.css already carries this same guard for
          .studio-details, so a stray second triangle is a known-real failure here. */}
      <summary className="-mx-1 flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-1 text-xs text-muted-foreground transition-colors marker:content-none hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-6 [&::-webkit-details-marker]:hidden">
        <Globe className="h-3.5 w-3.5 shrink-0" />
        <span>
          Searched the web · {sources.length} source{sources.length > 1 ? 's' : ''}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1 border-l border-border pl-3">
        {sources.map((s, i) => (
          <li key={i}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              title={s.title || s.url}
              className="inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:min-h-6"
            >
              <span className="truncate">{sourceLabel(s)}</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  )
}

// Copy is keyed by template kind (authoring) or 'grade'. A NEW template that isn't
// listed falls back to the generic 'default' entry — so it still gets sensible copy
// with no code change here (the registry drives actual behavior).
type CopyKey = 'default' | 'files' | 'notebook' | 'verbal' | 'document' | 'quiz' | 'about' | 'project' | 'grade'

/**
 * The route reports a spent rate limit as a JSON body (see the athena_rate_limited
 * 429), and the AI SDK hands that body to onError / useChat's `error` as the raw
 * error text. Pull the human sentence out of it; null for every other failure.
 *
 * Both the toast AND the in-transcript error bubble run through this. They used to
 * disagree — the toast said "usage limit" while the bubble said "Something went
 * wrong. Try again.", and since the bubble persists after the toast fades, the
 * professor was left reading a system failure instead of a budget that comes back
 * on its own (and "try again" was the one thing that wouldn't work). Caught in QA.
 */
export function athenaLimitMessage(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw)
    if (
      (parsed?.error === 'athena_rate_limited' ||
        parsed?.error === 'ai_disabled' ||
        parsed?.error === 'not_entitled') &&
      typeof parsed.message === 'string'
    ) {
      // ai_disabled: the institution/platform AI kill switch.
      // not_entitled: the school does not have Athena in its plan.
      // Like the rate limit, all three are refusals where "try again" is the
      // one thing that cannot work, so surface the policy sentence rather than
      // a system failure. Without this the raw JSON envelope reached a toast.
      return parsed.message
    }
  } catch {
    // Not JSON — the ordinary case for every other failure. Fall through.
  }
  return null
}

/** Map the (surface, kind) pair to a copy key, tolerating an unknown future kind. */
function copyKeyFor(surface: AssignmentAssistantSurface, kind?: string): CopyKey {
  if (surface === 'grade') return 'grade'
  if (
    kind === 'files' ||
    kind === 'notebook' ||
    kind === 'verbal' ||
    kind === 'document' ||
    kind === 'quiz' ||
    kind === 'about' ||
    kind === 'project'
  ) {
    return kind
  }
  return 'default'
}

const SUGGESTIONS: Record<CopyKey, string[]> = {
  default: [
    'Build this out on the topic we’re covering',
    'What did my class struggle with recently?',
    'Give me 3 ideas for this assignment',
  ],
  files: [
    'Draft an assignment on this week’s topic',
    'What did my class struggle with recently?',
    'Give me 3 assignment ideas',
  ],
  notebook: [
    'Add an intro cell and 3 starter code cells',
    'What did my class struggle with recently?',
    'Add a hint to the last cell',
  ],
  verbal: [
    'Draft 5 spoken questions on this week’s topic',
    'Add 2 multiple-choice questions',
    'Add a friendly greeting',
  ],
  document: [
    'Draft a lab report template',
    'What did my class struggle with recently?',
    'Add a citations section at the end',
  ],
  quiz: [
    'Make a 10-question quiz from module 1',
    'What did my class struggle with recently?',
    'Add 3 harder questions on the same topics',
  ],
  about: [
    'Fill in my schedule from my real due dates',
    'Does this page match my course?',
    'What’s missing from my page?',
    'Stress-test my policies',
  ],
  project: [
    'Draft phases and a rubric from my brief',
    'Turn my brief into phases with dates',
    'What deliverables does my brief actually imply?',
    'What am I not scoring that I said I would?',
  ],
  grade: ['Summarize this submission', 'Draft feedback: strong thesis, thin evidence'],
}

const SURFACE_COPY: Record<CopyKey, { subtitle: string; empty: string; placeholder: string }> = {
  default: {
    subtitle: 'Builds your assignment · never publishes',
    empty: 'Tell me what to build — I’ll draft it on the canvas. You review and publish.',
    placeholder: 'Ask Athena to build this…',
  },
  files: {
    subtitle: 'Fills the form · never saves',
    empty: 'Tell me what to assign — I’ll fill in the form. You review and save.',
    placeholder: 'Ask Athena to change this…',
  },
  notebook: {
    subtitle: 'Builds your notebook · never saves',
    empty: 'Tell me what to build — I’ll add and edit notebook cells. You review and save.',
    placeholder: 'Ask Athena to edit cells…',
  },
  verbal: {
    subtitle: 'Writes your questions · never saves',
    empty: 'Tell me the topic — I’ll draft the spoken questions. You review and save.',
    placeholder: 'Ask Athena to draft or edit questions…',
  },
  document: {
    subtitle: 'Writes your document · never saves',
    empty: 'Tell me what to write — I’ll draft it into the page. You review and save.',
    placeholder: 'Ask Athena to edit this…',
  },
  quiz: {
    subtitle: 'Writes your quiz · never publishes',
    empty: 'Tell me what to quiz on — I’ll pull from your modules and write the questions. They save to your draft as we go; nothing reaches students until you publish.',
    placeholder: 'Ask Athena to write questions…',
  },
  // Honest about persistence, unlike every sibling: the About builder AUTOSAVES
  // and the page is live to students, so "never saves" would be a lie here. The
  // safety story is Undo, and the copy leads with it.
  about: {
    // "undo the last change", NOT "anytime": Undo renders only on the newest fill,
    // and the transcript is in-memory per page mount — navigate away and it's gone
    // while the edit stays autosaved and live. On a page that publishes to students
    // on save, this one clause is the safety promise and must not round up.
    subtitle: 'Edits your live page · undo the last change',
    empty:
      'I can fill in this page from your real course, import your old syllabus (attach it with the paperclip), check the page still matches your course, or stress-test your policies. Edits autosave to your live page — you can undo my last change in one click.',
    placeholder: 'Ask Athena to build this page…',
  },
  project: {
    // Deliberately NOT "never saves": this surface proposes, and Apply is a real
    // write the professor performs. Promising "nothing saves" here would be the
    // same lie the About subtitle had to stop telling in the other direction.
    subtitle: 'You apply or discard · nothing saves itself',
    empty:
      'I can read the brief you already wrote and propose the phases and weighted rubric it implies, place your existing assignments and quizzes onto them, or check whether your weights add up. Everything I propose lands in a review card above your tabs — you read it, then apply or discard the whole thing. I never save on my own, and I never score anyone.',
    placeholder: 'Ask Athena to draft your phases…',
  },
  grade: {
    subtitle: 'Summaries & feedback · never grades',
    empty: 'I can summarize this submission or draft feedback from your notes. You set the grade.',
    placeholder: 'Ask Athena for a summary…',
  },
}

/**
 * The "nothing was saved" notice, shared by the two ways a fill can fail: the SDK rejecting
 * the model's input against its schema (no `fill` entry at all), and a fill that ran but
 * didn't land (no host, or a server refusal like an over-budget rubric).
 *
 * Warning-styled with an icon rather than a muted aside on purpose: Athena sometimes writes
 * a confident "I've updated it" immediately below this line, and quiet grey text loses that
 * argument — a professor reads the prose and believes the save happened.
 */
function FillFailedNotice({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{children}</span>
    </p>
  )
}

/** The two Frontier fills the PANEL persists itself (no editor is involved). */
const isPanelOwnedFill = (name: string): name is PanelOwnedFillTool =>
  (PANEL_OWNED_FILL_TOOLS as readonly string[]).includes(name)

/**
 * Frontier's own copy, layered OVER the per-template SURFACE_COPY rather than widening
 * CopyKey — the template's identity still matters in Frontier, only the cadence changes.
 */
const FRONTIER_COPY = {
  subtitle: 'Frontier — designing, not drafting',
  empty:
    "Tell me what you want students to learn and I'll design an assignment around something current in your field — then check it's still live before we build on it.",
  placeholder: 'What should students take away…',
}
const FRONTIER_SUGGESTIONS = [
  'Design an assignment that will not go stale',
  "Make this one students can't copy",
  "What's current in my field I could build on?",
]
/** A quiz isn't a deliverable, so the framing shifts from "assignment" to "questions". */
const FRONTIER_QUIZ_COPY = {
  subtitle: 'Frontier — designing, not drafting',
  empty:
    "Tell me what you want students to know and I'll build questions around something current in your field — after checking it's still live.",
  placeholder: 'What should students know…',
}
const FRONTIER_QUIZ_SUGGESTIONS = [
  'Write questions that stay current',
  "Make these hard to pass around",
  "What's changed in my field I could test on?",
]

/**
 * Copy for a surface with NO registered editor — the assignments and quizzes LIST pages.
 *
 * The 'default' entry below promises a canvas ("I'll draft it on the canvas", "Build this out")
 * which is a lie on a list screen: nothing registers there, so `apply_edits` isn't even in the
 * tool set and there is nothing to draft onto. Athena is genuinely useful here — it can read
 * class performance and talk through what to assign — so the copy should offer that instead of
 * a canvas that doesn't exist.
 */
// Shown when NO editor is registered — i.e. a list page. Deliberately noun-NEUTRAL: this
// same copy renders on the assignments list and the quizzes list, and the panel cannot tell
// them apart (there is no active surface on a list, so `kind` is undefined). Saying
// "assignment" here was wrong half the time. Threading a prop down just to pick a noun would
// buy one word for a new plumbing path, so the copy carries both instead.
const NO_HOST_COPY = {
  subtitle: 'Ask about this course',
  empty:
    'I can talk through what to assign next, or what your class has been struggling with. Open an assignment or a quiz and I can build it with you there.',
  placeholder: 'Ask about this course…',
}
const NO_HOST_SUGGESTIONS = [
  'What did my class struggle with recently?',
  'What should I assign next?',
  'Ideas for this week’s topic',
]

/** Frontier only applies while AUTHORING an assignment; a quiz has no rubric budget and
 *  grading has no design work, so the toggle is not offered there at all. */
const frontierApplies = (surface: AssignmentAssistantSurface, assignmentId?: string) =>
  // Every authoring template, quizzes included — a quiz simply skips the rubric step.
  // A saved subject id is required, and MUST match the server's tool gate: the create wizard
  // registers before a row exists, so the route withholds the two save tools there while the
  // prompt still orders them — the model complies by printing the private notes as chat
  // prose, which is both unsaved and a leak of the anti-copying guard.
  surface === 'authoring' && !!assignmentId

/**
 * Hard ceiling on CONSECUTIVE auto-sent turns (a professor message always resets it to 0).
 *
 * `sendAutomaticallyWhen` re-arms after each settled fill so the model can acknowledge it,
 * which means the chain's length is bounded by nothing: `stopWhen: stepCountIs(6)` on the
 * route bounds steps WITHIN one request, not the number of requests the client fires. The
 * refused-fill guard below closes the loop QA actually caught; this closes the general case,
 * where every fill succeeds and the model simply keeps going.
 *
 * 4 leaves real headroom: a Frontier build legitimately chains canvas → rubric → notes, and
 * a model that spreads those across turns instead of bundling them needs three. The daily
 * per-model rate limit is the outer backstop; this is the per-conversation one.
 */
const MAX_AUTO_SEND_CHAIN = 4
/**
 * Hard ceiling on tool calls within ONE assistant turn, independent of the chain counter.
 *
 * Browser QA measured 115+ context-tool calls accumulating on a single turn, about one a
 * second, monotonic, with no text ever produced and the Stop button the only way out (#651).
 * MAX_AUTO_SEND_CHAIN could not stop it: rung (2) below returns an unconditional yes when the
 * continuation lands on the same assistant message id, so the chain counter never incremented
 * and its ceiling was never reached. A counter that can be frozen is not a bound.
 *
 * This one cannot be frozen, because it counts something that only grows: the tool parts
 * already on the message. 2x the server's 6-step budget, so a legitimate multi-step turn is
 * unaffected.
 */
const MAX_TOOL_CALLS_PER_TURN = 12

/** Put a row back where it was, tolerating a list that changed underneath. */
function reinsert<T extends { id: string }>(list: T[], row: T, index: number): T[] {
  if (list.some((c) => c.id === row.id)) return list
  const next = [...list]
  next.splice(Math.min(index, next.length), 0, row)
  return next
}

const isFillTool = (name: string): name is AssignmentFillTool =>
  (ASSIGNMENT_FILL_TOOLS as readonly string[]).includes(name)

export function AssignmentAthenaPanel({
  sectionId,
  surface,
  kind,
  assignmentId,
  mode = DEFAULT_ASSIGNMENT_ASSISTANT_MODE,
  onModeChange,
  getScreen,
  onFill,
  onAttach,
  onRubricSaved,
  hasHost = true,
  getInitialMessages,
  onMessagesChange,
  getInitialConversationId,
  onStartNewChat,
  onResumeConversation,
  open,
  onActivity,
  onRegisterNotifier,
  pendingPrompt,
  onPendingPromptSent,
  onClose,
  className,
}: AssignmentAthenaPanelProps) {
  const router = useRouter()
  const [conversationId] = useState(() => getInitialConversationId?.() ?? crypto.randomUUID())
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const copyKey = copyKeyFor(surface, kind)
  const isFrontier = mode === 'frontier' && frontierApplies(surface, assignmentId)
  const isQuiz = kind === 'quiz'

  // ── Chat attachments ───────────────────────────────────────────────────
  // Files upload through the console's hardened route (staff auth, type/size
  // whitelist, Office→PDF) into the conversation-scoped prefix, then ride the
  // next message as file parts the chat route inlines for the model. Same hook,
  // same endpoint and same limits the professor console and the student dock
  // use, on every kind and both surfaces.
  const attachmentLimits = useMemo(() => resolveAthenaModelDef(DEFAULT_ATHENA_MODEL_ID).attachments, [])
  const chatAttachments = useAthenaAttachments({
    limits: attachmentLimits,
    endpoint: '/api/professor-assistant/upload',
    fields: { sectionId, conversationId, modelId: DEFAULT_ATHENA_MODEL_ID },
  })
  const copy = !hasHost
    ? { ...SURFACE_COPY[copyKey], ...NO_HOST_COPY }
    : isFrontier
      ? { ...SURFACE_COPY[copyKey], ...(isQuiz ? FRONTIER_QUIZ_COPY : FRONTIER_COPY) }
      : SURFACE_COPY[copyKey]
  const suggestions = !hasHost
    ? NO_HOST_SUGGESTIONS
    : isFrontier
      ? isQuiz
        ? FRONTIER_QUIZ_SUGGESTIONS
        : FRONTIER_SUGGESTIONS
      : SUGGESTIONS[copyKey]

  // Move focus into the composer when the dock opens — most importantly for the ":" shortcut
  // in the document editor, which summons Athena but would otherwise leave the caret in the
  // document. Non-modal, so this is an initial focus move, not a focus trap.
  useEffect(() => {
    if (open) composerRef.current?.focus()
  }, [open])

  // ── Rate-limit usage for THIS panel's pool ─────────────────────────────
  // Every Athena surface has its own daily budget, so this panel reads and shows
  // only its own — the scope is derived server-side by the same resolver the route
  // charges against. Purely advisory: the route enforces independently and 429s if
  // a race slips past the block below.
  const [usage, setUsage] = useState<AthenaUsageStatus | null>(null)
  const refreshUsage = useCallback(async () => {
    try {
      const res = await getPanelAthenaUsage(sectionId, surface, kind, assignmentId)
      if ('status' in res) setUsage(res.status)
    } catch (err) {
      // Every caller fires this bare (`void refreshUsage()`, and ResetCountdown's
      // onElapsed), so an unhandled rejection here would surface as a browser error
      // rather than a no-op. Usage display is advisory — the route enforces the
      // limit regardless — so swallowing it degrades to "no chip", never to a break.
      logger.error('AssignmentAthenaPanel.refreshUsage: failed', err, { sectionId, surface })
    }
  }, [sectionId, surface, kind, assignmentId])
  // Only once the dock is actually OPEN. The dock keeps this panel permanently
  // mounted and slides it offscreen, so an unconditional fetch would hit the server
  // on every assignments/quizzes page load — including the majority where Athena is
  // never opened — and everything this feeds (the notice, the Send gate, the
  // auto-send guard) is unreachable while closed.
  useEffect(() => {
    if (open) void refreshUsage()
  }, [open, refreshUsage])

  // Spent only when EVERY model is out: exhausting Flash just fails over to Pro
  // (which UsageNotice announces, since this panel has no model picker to explain
  // why replies suddenly got slower).
  const allExhausted =
    !!usage &&
    failoverCandidates(DEFAULT_ATHENA_MODEL_ID).every(
      (d) => usage.models.find((m) => m.id === d.id)?.exhausted,
    )

  const { messages, sendMessage, setMessages, addToolResult, status, error, stop } = useChat({
    id: conversationId,
    transport: new DefaultChatTransport({
      api: '/api/assignment-assistant',
      // `mode` belongs in the STATIC body, not the per-message one: after a fill resolves,
      // sendAutomaticallyWhen auto-sends a follow-up turn that carries ONLY this body. Put
      // mode in the per-message body and that turn would silently arrive as 'standard',
      // dropping Frontier's tools mid-arc. The panelKey remount keeps this value correct.
      // The GATED value, not the raw provider mode: arming Frontier in a studio and then
      // navigating to a list would otherwise build the full Frontier prompt on a surface where
      // both save tools are withheld — the model then prints the private notes as chat prose.
      body: {
        sectionId,
        surface,
        kind,
        assignmentId,
        mode: mode === 'frontier' && frontierApplies(surface, assignmentId) ? 'frontier' : 'standard',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }),
    // After a fill tool is resolved client-side, auto-send so the model acknowledges.
    // After a fill resolves, auto-send so the model acknowledges — EXCEPT when the fill was
    // REFUSED. A refused fill used to re-arm this, and because stopWhen bounds steps per
    // REQUEST rather than the chain of requests, refusal → auto-send → retry → refusal had
    // no bound at all: QA measured 268+ tool calls and ~15 false "I've updated the rubric"
    // claims from a single over-budget request. The model already has the refusal text in
    // the tool result, so it needs no extra turn to learn about it — the professor's next
    // message is the right trigger.
    sendAutomaticallyWhen: ({ messages: msgs }) => {
      // (0) Out of budget. An auto-sent follow-up the professor never typed would
      // only earn a 429, so stop the chain quietly — their own next send still
      // gets the explanatory toast.
      if (allExhausted) return false
      if (!lastAssistantMessageIsCompleteWithToolCalls({ messages: msgs })) return false
      const last = msgs[msgs.length - 1]
      if (!last || last.role !== 'assistant') return false

      /* (0b) THE ROOT CAUSE of the #651 loop, and the reason a step cap could not stop it.
         This continuation exists for exactly one thing, as the comment above says: a FILL
         tool was resolved in the browser and the model should acknowledge it. But the SDK's
         lastAssistantMessageIsCompleteWithToolCalls above cannot express that. It filters
         only `providerExecuted` parts (ai/dist/index.mjs:13883), meaning tools the MODEL
         PROVIDER ran, such as Google search. Our own `execute()` tools are app-run, so it
         reports them as "complete" too.

         So every time the server ended a turn on server-run context reads — which is exactly
         what happens when it spends its 6-step budget gathering and never acts — this fired
         and started another request. The step cap was not bounding the loop, it was PACING
         it: 6 steps, continue, 6 steps, continue, measured at 115+ calls and one a second.

         Gating on a client-resolved tool actually being present makes the continuation match
         its stated purpose. A turn that only read context now simply ends, and the stalled
         notice reports it: one wasted turn instead of an unbounded one. */
      const resolvedAFillTool = (last.parts as AnyPart[]).some(
        (p) =>
          typeof p.type === 'string' &&
          (CLIENT_RESOLVED_TOOL_TYPES as readonly string[]).includes(p.type) &&
          p.state === 'output-available',
      )
      if (!resolvedAFillTool) return false

      // (1) A REFUSED fill must not re-arm the chain. The model already has the refusal text
      // in the tool result, so it needs no extra turn to learn about it.
      const refused = (last.parts as AnyPart[]).some(
        (p) =>
          typeof p.type === 'string' &&
          p.type.startsWith('tool-') &&
          p.state === 'output-available' &&
          (p.output as { applied?: unknown } | null)?.applied === false,
      )
      if (refused) return false

      /* (1b) The un-freezable bound. Counts tool parts already on this turn, so it holds
         even when rung (2) below keeps waving the same message through and the chain counter
         never moves. Without it a turn can iterate context tools forever, and because the
         stall notice is gated on `!isLoading` it stays invisible the entire time: the loop
         silences the very warning that exists to report it (#651). */
      const toolCallsThisTurn = (last.parts as AnyPart[]).filter(
        (p) => typeof p.type === 'string' && p.type.startsWith('tool-'),
      ).length
      if (toolCallsThisTurn >= MAX_TOOL_CALLS_PER_TURN) {
        setAutoStopped(true)
        return false
      }

      // (2) Already authorised THIS message — answer consistently without counting twice.
      // The predicate can be evaluated more than once for the same state during a render
      // pass, and double-counting would cut a legitimate chain short.
      if (lastAutoSentIdRef.current === last.id) return true

      // (3) The hard ceiling.
      if (autoSendChainRef.current >= MAX_AUTO_SEND_CHAIN) {
        setAutoStopped(true)
        return false
      }
      autoSendChainRef.current += 1
      lastAutoSentIdRef.current = last.id
      return true
    },
    onError: (err: Error) =>
      toast.error(
        athenaLimitMessage(err.message) || err.message || 'Something went wrong. Please try again.',
      ),
  })

  const isLoading = status === 'submitted' || status === 'streaming'

  // ── Resume (saved Studio chats) ──────────────────────────────────────
  // The SAME scope mapping the route persists under (resolveStudioConversationScope
  // is the one shared implementation) — otherwise this list could silently show a
  // different set of threads than the ones the current turn is actually saving to.
  const studioScope = useMemo(
    () => resolveStudioConversationScope({ surface, kind, assignmentId }),
    [surface, kind, assignmentId],
  )
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  // True while a chosen thread is being fetched. The curtain stays OPEN and busy until
  // it resolves: closing first left the professor looking at the OLD conversation for a
  // whole round trip with no sign the click registered (Doherty).
  const [resuming, setResuming] = useState(false)
  const [historyConversations, setHistoryConversations] = useState<StudioConversationSummary[]>([])
  const historyTriggerRef = useRef<HTMLButtonElement>(null)

  const openHistory = useCallback(async () => {
    setHistoryOpen(true)
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const { data, error } = await listStudioConversations(sectionId, studioScope)
      // A failed read must never render as "you have no chats" — that reads as data
      // loss, not as a bug, and a professor escalates rather than retries.
      if (error) setHistoryError("Couldn't load your past chats.")
      setHistoryConversations(data)
    } catch (err) {
      logger.error('AssignmentAthenaPanel.openHistory: failed', err, { sectionId })
      setHistoryError("Couldn't load your past chats.")
      setHistoryConversations([])
    } finally {
      setHistoryLoading(false)
    }
  }, [sectionId, studioScope])

  /** Resume dropdown selection — replaces the current session with the saved one. */
  const handleResumeSelect = useCallback(
    async (conversation: { id: string }) => {
      setResuming(true)
      try {
        const result = await loadStudioConversation(sectionId, conversation.id)
        if (result.error || !onResumeConversation) {
          toast.error("Couldn't open that chat. Please try again.")
          return
        }
        // Remounts the panel on a new panelKey, so there is nothing to close afterwards.
        onResumeConversation({ mode: result.mode, conversationId: conversation.id, messages: result.messages })
      } finally {
        setResuming(false)
      }
    },
    [sectionId, onResumeConversation],
  )

  /**
   * Remove a saved chat from the list. Optimistic: the row disappears immediately and
   * the toast's Undo restores it, because archiving is reversible — the transcript is
   * never destroyed. On failure the row is put back rather than left missing, so the
   * list never disagrees with the database.
   */
  const handleHistoryRemove = useCallback(
    async (item: { id: string }) => {
      // Snapshot the ROW and its position, never the whole list. Restoring a whole-list
      // snapshot resurrected rows that a later delete had since archived, so the curtain
      // disagreed with the database until it was reopened.
      const index = historyConversations.findIndex((c) => c.id === item.id)
      const removed = historyConversations[index]
      if (!removed) return
      setHistoryConversations((list) => list.filter((c) => c.id !== item.id))

      // Archiving the ACTIVE thread would leave the panel writing turns into a
      // conversation that `listStudioConversations` filters out forever. Start a fresh
      // one, exactly as the console and the student dock both do.
      if (item.id === conversationId) onStartNewChat?.()

      const res = await setStudioConversationArchivedAction(sectionId, item.id, true)
      if (res.error) {
        setHistoryConversations((list) => reinsert(list, removed, index))
        toast.error(res.error)
        return
      }
      toast.success('Chat deleted', {
        // The app's toaster is top-right, which is exactly where this dock's header sits
        // while it is open — a toast raised from the history button covered that button,
        // and sonner keeps a hovered toast alive indefinitely.
        position: 'bottom-center',
        action: {
          label: 'Undo',
          onClick: () => {
            void setStudioConversationArchivedAction(sectionId, item.id, false).then((undo) => {
              if (undo.error) {
                toast.error(undo.error)
                return
              }
              setHistoryConversations((list) => reinsert(list, removed, index))
            })
          },
        },
      })
    },
    [sectionId, historyConversations, conversationId, onStartNewChat],
  )

  /* The runaway-loop detector (#651) lives in lib/ai/athena-core/turn-state.ts
     so its test exercises the same code this renders, rather than a copy of it. */
  const stalledWithoutReply = useMemo(() => isStalledWithoutReply(messages as TurnMessage[]), [messages])

  // Restore the transcript this panelKey had before, if any. Flipping Frontier remounts the
  // panel (mode is part of panelKey) — that is what keeps a half-standard/half-Frontier
  // history from ever reaching the model — but the conversation itself is no longer thrown
  // away: the dock holds one transcript per key and hands it back here.
  //
  // Restored tool parts are all `output-available`, and the auto-apply effect only acts on
  // `input-available`, so re-seeding can never re-apply a fill that already landed.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    const prior = getInitialMessages?.()
    if (prior && prior.length) setMessages(prior)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onMessagesChangeRef = useRef(onMessagesChange)
  useEffect(() => {
    onMessagesChangeRef.current = onMessagesChange
  })
  useEffect(() => {
    // Skip the initial empty render so a fresh mount can't wipe a stored transcript before
    // the seeding effect above has run.
    if (!seeded.current) return
    onMessagesChangeRef.current?.(messages)
  }, [messages])

  // Apply fill tool calls to the host form (auto-apply), then resolve them.
  // appliedRef guards against double-apply across re-renders; undoFns holds each
  // fill's revert; `fills` drives the per-fill chip (summary + Undo).
  // Auto-send chain bookkeeping (see MAX_AUTO_SEND_CHAIN). Refs, not state: the predicate
  // reads them during a render pass, and they must reset on remount — which they do, since a
  // mode/surface change remounts this panel entirely.
  const autoSendChainRef = useRef(0)
  const lastAutoSentIdRef = useRef<string | null>(null)
  const [autoStopped, setAutoStopped] = useState(false)
  const appliedRef = useRef<Set<string>>(new Set())
  // Matches FillResult.undo's own return type — see the note there for what `false` means.
  const undoFns = useRef<Record<string, (() => boolean | void) | undefined>>({})
  const keepFns = useRef<Record<string, (() => void) | undefined>>({})
  const [fills, setFills] = useState<
    Record<string, { summary: string; undone: boolean; kept: boolean; applied: boolean; canUndo: boolean; canKeep: boolean }>
  >({})
  // Keep the latest onFill/getScreen without retriggering effects on every parent render.
  const onRubricSavedRef = useRef(onRubricSaved)
  useEffect(() => {
    onRubricSavedRef.current = onRubricSaved
  })
  const onFillRef = useRef(onFill)
  const getScreenRef = useRef(getScreen)
  useEffect(() => {
    onFillRef.current = onFill
    getScreenRef.current = getScreen
  })

  // Change-awareness baseline: the canvas state as Athena LAST LEFT IT. Updated only after
  // Athena's own fills (below), so anything the professor changes by hand or via Undo in
  // between surfaces as a diff on the next message (see `send`). In-memory only — the chat
  // is ephemeral, so there's nothing to persist.
  const lastSeenRef = useRef<StateSnapshot | null>(null)

  // Pending deferred-apply frames. Cancelled on unmount so a queued fill can't fire after
  // the panel is torn down (surface switch / navigation) and apply to a stale/new editor.
  const pendingRafs = useRef<Set<number>>(new Set())
  useEffect(() => {
    const rafs = pendingRafs.current
    return () => {
      for (const r of rafs) cancelAnimationFrame(r)
      rafs.clear()
    }
  }, [])

  /**
   * The two Frontier fills the panel owns. Unlike every other fill there is no editor to
   * write into — a rubric isn't part of a notebook or document, and design notes must never
   * reach a student-facing field — so these persist through vetted server actions instead.
   *
   * Async, so no requestAnimationFrame dance (that exists only to keep TipTap's commands
   * out of a React lifecycle) and no change-diff re-baselining, because the canvas did not
   * move. Undo works by calling the SAME action with the value that was there before, which
   * is why each action returns `previous` and is its own inverse.
   */
  const handlePanelFill = useCallback(
    async (tool: PanelOwnedFillTool, id: string, input: unknown) => {
      const settle = (applied: boolean, summary: string, undo?: () => void) => {
        if (undo) undoFns.current[id] = undo
        // Frontier's panel-owned fills (rubric save) never offer Keep — there is no
        // canvas marker to dismiss for a server-action write.
        setFills((prev) => ({ ...prev, [id]: { summary, undone: false, kept: false, applied, canUndo: !!undo, canKeep: false } }))
        // These two fills write through a server action, so the HOST's server-rendered panes
        // (the studio's rubric card, in particular) are stale until the route re-fetches.
        // Frontier navigates the professor straight to the rubric step, so without this they
        // land on an empty pane one second after a chip said "Saved a rubric with 3
        // questions." router.refresh() re-fetches server components while preserving client
        // state, so an unsaved canvas edit survives it.
        if (applied) router.refresh()
        void addToolResult({ tool, toolCallId: id, output: { applied, summary } })
      }

      // The route withholds both tools when there's no saved assignment, so this is
      // belt-and-braces — but it must never throw a NULL uuid at the server action.
      if (!assignmentId) {
        settle(false, 'There is no saved assignment to attach that to yet — save it first.')
        return
      }

      try {
        if (tool === 'set_rubric') {
          // Belt-and-braces: the route withholds set_rubric on the quiz kind, because a quiz
          // has no settings.rubric to write into.
          if (isQuiz) {
            settle(false, 'A quiz has no rubric to save — put the marks on the questions instead.')
            return
          }
          const res = await applyFrontierRubric(sectionId, assignmentId, input)
          if ('error' in res) return settle(false, res.error)
          const previous = res.previous
          // Push what the SERVER stored, never the model's raw input. rubricQuestionSchema
          // defaults `criteria` to [], so a question the model sent without that key is
          // persisted WITH it — and the rubric editor does `q.criteria.reduce(...)`. Handing
          // the host the raw input would crash it on the very next render, directly beneath a
          // chip reading "Saved".
          const count = res.saved?.questions.length ?? 0
          onRubricSavedRef.current?.(res.saved)
          settle(true, `Saved a rubric with ${count} question${count === 1 ? '' : 's'}.`, () => {
            // Unlike a host undo (pure React state, can't fail) this one is a DB write, so
            // it must not silently no-op behind a chip that already says "Reverted".
            void applyFrontierRubric(sectionId, assignmentId, previous).then((r) => {
              if ('error' in r) toast.error(r.error)
              else onRubricSavedRef.current?.(previous)
            })
          })
          return
        }
        const res = await saveAssignmentDesign(sectionId, assignmentId, input, isQuiz ? 'quiz' : 'assignment')
        if ('error' in res) return settle(false, res.error)
        const previous = res.previous
        settle(true, 'Saved the private design notes.', () => {
          void saveAssignmentDesign(sectionId, assignmentId, previous, isQuiz ? 'quiz' : 'assignment').then((r) => {
            if ('error' in r) toast.error(r.error)
          })
        })
      } catch {
        // Never leave the tool call unresolved: an orphan makes the next turn fail with
        // AI_MissingToolResultsError, which the professor would see as a dead chat.
        settle(false, 'That could not be saved. Please try again.')
      }
    },
    [sectionId, assignmentId, addToolResult, router, isQuiz],
  )

  useEffect(() => {
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      for (const part of m.parts as AnyPart[]) {
        if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue
        const toolName = part.type.slice('tool-'.length)
        if (!isFillTool(toolName)) continue
        if (part.state !== 'input-available') continue
        const id = part.toolCallId
        if (!id || appliedRef.current.has(id)) continue
        appliedRef.current.add(id) // sync guard against double-processing across effect re-runs
        const input = part.input
        // Panel-owned fills bypass the host entirely (see handlePanelFill).
        if (isPanelOwnedFill(toolName)) {
          void handlePanelFill(toolName, id, input)
          continue
        }
        // Apply the fill on the NEXT FRAME, not synchronously here: the document adapter's
        // TipTap editor.commands (insertContent/setContent) run inside this effect trip
        // React's "flushSync was called from inside a lifecycle" warning. A frame later is
        // still instant for the professor, and the appliedRef guard above prevents any
        // double-apply while it's pending.
        const raf = requestAnimationFrame(() => {
          pendingRafs.current.delete(raf)
          const res = onFillRef.current(toolName, input)
          const applied = res.applied !== false // default true; only the no-host fallback returns false
          if (applied) {
            undoFns.current[id] = res.undo
            keepFns.current[id] = res.keep
            // Re-baseline AFTER Athena's own edit lands (next frame, once the host has
            // committed state) so the change-diff only reports the professor's later edits.
            const rebase = requestAnimationFrame(() => {
              pendingRafs.current.delete(rebase)
              lastSeenRef.current = snapshotOf(getScreenRef.current().authoring)
            })
            pendingRafs.current.add(rebase)
          }
          // canUndo is tracked separately from `applied`: a fill can genuinely land and
          // still not be revertible (a generation run is already streaming server-side).
          // Rendering Undo for those was worse than useless — it did nothing and then
          // reported "Reverted" over a run that was still adding questions.
          setFills((prev) => ({
            ...prev,
            [id]: { summary: res.summary, undone: false, kept: false, applied, canUndo: !!res.undo, canKeep: !!res.keep },
          }))
          void addToolResult({ tool: toolName, toolCallId: id, output: { applied, summary: res.summary } })
        })
        pendingRafs.current.add(raf)
      }
    }
  }, [messages, addToolResult, handlePanelFill])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, status])

  // Detect the busy→settled edge (prev status held in a ref) and report it up so
  // the dock can drive its collapsed activity dot. onActivity is stable.
  // The same edge is where a turn has just been counted, so re-read this pool's
  // usage here rather than adding a second effect for it.
  const prevStatusRef = useRef(status)
  useEffect(() => {
    const wasBusy = prevStatusRef.current === 'submitted' || prevStatusRef.current === 'streaming'
    const isBusy = status === 'submitted' || status === 'streaming'
    prevStatusRef.current = status
    if (isBusy) onActivity?.('working')
    else if (wasBusy) {
      onActivity?.('done')
      void refreshUsage()
    }
  }, [status, onActivity, refreshUsage])

  // Undo is offered on the NEWEST applied fill only. Each fill's undo restores a whole
  // snapshot taken before it, so an older chip's Undo would silently discard everything
  // done since — later fills AND the professor's own hand edits. Older chips keep their
  // summary as a record of what happened; only the last one stays revertible.
  const latestFillId = useMemo(() => {
    const live = Object.entries(fills).filter(([, f]) => f.applied && !f.undone)
    return live.length ? live[live.length - 1][0] : null
  }, [fills])

  // Undo reverts the fill. We deliberately do NOT re-baseline here — leaving lastSeen at
  // the post-fill state means the next message's diff reports "the professor cleared/…",
  // so Athena knows the canvas changed and rebuilds instead of trusting a stale memory.
  //
  // The assistant note is for the MODEL as much as the professor: the transcript still
  // carries the fill call and its "applied" result, and QA proved that history wins —
  // a stress-test attacked a policy that had been undone, because nothing in the
  // conversation ever said so. The change-diff alone was too weak a signal; an explicit
  // assistant turn is what actually corrects the record.
  const handleUndo = useCallback(
    (id: string) => {
      // A host can refuse at click time (About: a hand edit since the fill, or the
      // professor already resolved this turn from the canvas's own Keep/Undo). Only
      // an explicit `false` counts as a refusal — every host that predates this
      // return value keeps working exactly as before. Skipping the "Reverted" chip
      // and the synthetic message on refusal matters for two different readers: the
      // professor would otherwise see a chip claiming success over content that is
      // still there, and Athena would be told a change is gone that never left —
      // exactly the stale-history problem the message below exists to prevent in
      // the first place, just triggered by a false claim instead of a missing one.
      const reverted = undoFns.current[id]?.()
      if (reverted === false) return
      setFills((prev) => ({ ...prev, [id]: { ...prev[id], undone: true } }))
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          parts: [{ type: 'text', text: 'Undone — that change is no longer on the page.' }],
        } as UIMessage,
      ])
    },
    [setMessages],
  )

  /* Keep touches no content — the fill is already saved either way — so unlike Undo this
     needs no assistant transcript turn (nothing about the canvas state changed for Athena
     to be told about) and no re-baseline. It just clears the "review this" marker. */
  const handleKeep = useCallback((id: string) => {
    keepFns.current[id]?.()
    setFills((prev) => ({ ...prev, [id]: { ...prev[id], kept: true } }))
  }, [])

  // File attachment: the professor picks a PDF/slide deck/doc/image and it becomes a
  // CHAT attachment Athena reads on the next send. No `canAttach` gate any more — a
  // chat attachment is scoped to the CONVERSATION, not to a saved row, so it works on
  // every kind, on both surfaces, and before the assignment has ever been saved.
  //
  // A host may ALSO register an onAttach to put the same file somewhere its own
  // pipeline can use (the quiz studio registers one that uploads to course-materials
  // and makes it a real module item, which is what generate_questions reads — a chat
  // attachment has no module id, so that path is an addition, not an alternative).
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)
  // Post a note into the chat (always visible in the panel — a toast can sit behind the
  // fullscreen studio overlay, so the chat line is the reliable feedback channel).
  const postAthenaNote = useCallback(
    (text: string) => {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', parts: [{ type: 'text', text }] } as UIMessage,
      ])
    },
    [setMessages],
  )
  // Hand the poster to the dock while this panel is mounted, so a host screen can put a
  // line in the transcript when something settles outside a turn. Cleared on unmount: a
  // note posted into a torn-down chat has nowhere to go.
  useEffect(() => {
    onRegisterNotifier?.(postAthenaNote)
    return () => onRegisterNotifier?.(null)
  }, [onRegisterNotifier, postAthenaNote])

  const handleAttach = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      // Always a chat attachment first. The hook validates against the model's own
      // whitelist (toasting a rejection), uploads in the background, and the ready
      // file rides the next send as a file part the route inlines for the model.
      //
      // Bail if it staged nothing. Athena has no copy of a rejected file, so telling
      // the professor she can read it would be #652 again pointing the other way, and
      // a host's onAttach would otherwise write bytes the model will never see. The
      // hook has already said why, by toast.
      const staged = chatAttachments.addFiles([file])
      if (staged.length === 0) return
      if (!onAttach) return
      // A host that registered onAttach gets the same file as well, for its own
      // pipeline. Failure there is NOT an attach failure: the chat copy is staged
      // and readable either way, so the note says what was lost and nothing else.
      //
      // Deliberately does not surface res.error. On the quiz studio those strings
      // are pipeline vocabulary ("Unsupported file type for extraction") and read
      // as a contradiction beside "I can read it". Nor does it say "try again":
      // re-attaching would stage a second copy of a file already staged, burning
      // an attachment slot and doubling its per-turn cost.
      setIsUploading(true)
      try {
        const res = await onAttach(file)
        if ('error' in res) {
          postAthenaNote(
            `📎 **${file.name}** is attached and I can read it now. I couldn't add it to your course material as well, so bulk question generation won't see it — a PDF or slide deck works best for that.`,
          )
          return
        }
        postAthenaNote(res.note)
      } finally {
        setIsUploading(false)
      }
    },
    [onAttach, postAthenaNote, chatAttachments],
  )

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (isLoading) return
      // Attached files ride this message as file parts. A send with files and no
      // text is a legitimate gesture ("here's the paper this assignment is on").
      const files = chatAttachments.readyFileParts()
      if (!trimmed && files.length === 0) return
      if (chatAttachments.uploading) {
        toast.error('Hold on — attachments are still uploading', { id: 'athena-uploading' })
        return
      }
      // Courtesy block so the professor gets a sentence instead of a failed turn.
      // The route is the real gate; this only spares them the round trip.
      if (allExhausted) {
        // Fixed id so an impatient professor pressing Enter repeatedly replaces the
        // toast instead of stacking identical copies.
        toast.error("You've reached today's Athena usage limit — it refreshes automatically.", {
          id: 'athena-limit',
        })
        return
      }
      setInput('')
      // The professor speaking is always allowed to continue, and clears any prior stall.
      autoSendChainRef.current = 0
      lastAutoSentIdRef.current = null
      setAutoStopped(false)
      const screen = getScreen()
      // Compute what the professor changed on the canvas since Athena last acted, so the
      // model has context of the sequence of events (manual edits, deletes, reorders, Undo)
      // — not just the final state. First turn: set the baseline, report no changes.
      let changes: string[] = []
      const authoring = screen.authoring
      if (authoring) {
        const curr = snapshotOf(authoring)
        if (lastSeenRef.current) changes = diffAuthoring(lastSeenRef.current, curr)
        else lastSeenRef.current = curr
      }
      if (files.length) {
        chatAttachments.clear()
        if (trimmed) sendMessage({ text: trimmed, files }, { body: { screen, changes } })
        else sendMessage({ files }, { body: { screen, changes } })
      } else {
        sendMessage({ text: trimmed }, { body: { screen, changes } })
      }
    },
    [isLoading, allExhausted, sendMessage, getScreen, chatAttachments],
  )

  // ── Consume a prompt typed into the floating ask line ───────────────────
  // Exactly once. In practice the dock clears `pendingPrompt` synchronously in the same
  // commit, which is what actually prevents a second send; the id ref is cheap insurance
  // for a host that wires this without `onPendingPromptSent`, and it is written BEFORE
  // send() so a double-invoked effect bails on the second pass. Mutation-testing during
  // review showed the ref is unreachable with the dock as the only caller — keeping it
  // anyway, because sending a professor's request twice is worse than not sending it.
  //
  // Deliberately waits for `!isLoading`: `send` no-ops while a turn is in flight, so
  // consuming during a stream would swallow the prompt silently. `send`'s identity
  // changes when isLoading flips, which re-runs this effect and delivers it then.
  const sentPromptIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!pendingPrompt || isLoading) return
    if (sentPromptIdRef.current === pendingPrompt.id) return
    sentPromptIdRef.current = pendingPrompt.id
    send(pendingPrompt.text)
    onPendingPromptSent?.()
  }, [pendingPrompt, isLoading, send, onPendingPromptSent])

  const hasMessages = messages.length > 0

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      {/* Header */}
      {/* Header and the curtain that drops from under it are SIBLINGS, deliberately.
          Nesting the curtain inside the header put it in the header's own stacking
          context, where a positioned child paints above its parent's content — so the
          CLOSED curtain covered the very buttons that open it, and on mobile (where the
          dock is a full-screen sheet) it hid the only visible way out. z-index cannot
          order a parent against its own child; it can order two siblings, which is what
          the z-40 / z-30 pair below now actually does. */}
      <div className="relative z-20 shrink-0">
      <div className="relative z-40 flex items-center gap-2 border-b border-border/60 bg-card px-3 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Athena</p>
          <p className="truncate text-xs text-muted-foreground">{copy.subtitle}</p>
        </div>
        {onStartNewChat && (
          <button
            type="button"
            onClick={() => {
              setHistoryOpen(false)
              onStartNewChat()
            }}
            aria-label="New chat"
            title="New chat"
            className="flex h-11 w-11 md:h-7 md:w-7 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SquarePen className="h-4 w-4" />
          </button>
        )}
        {onResumeConversation && (
          <button
            type="button"
            ref={historyTriggerRef}
            onClick={() => (historyOpen ? setHistoryOpen(false) : void openHistory())}
            aria-label="Chat history"
            aria-expanded={historyOpen}
            aria-controls="athena-studio-history"
            title="Chat history"
            className={`flex h-11 w-11 md:h-7 md:w-7 items-center justify-center rounded-xl transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              historyOpen ? 'bg-muted text-foreground' : 'text-muted-foreground'
            }`}
          >
            <History className="h-4 w-4" />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Athena"
            className="flex h-11 w-11 md:h-7 md:w-7 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
        {onResumeConversation && (
          <AthenaHistoryDrop
            id="athena-studio-history"
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            loading={historyLoading || resuming}
            error={historyError}
            onRetry={() => void openHistory()}
            returnFocusRef={historyTriggerRef}
            items={historyConversations}
            activeId={conversationId}
            onSelect={(item) => void handleResumeSelect(item)}
            onRemove={(item) => void handleHistoryRemove(item)}
            // On a screen with no editor registered (an assignment/quiz DETAIL or LIST
            // page) Athena has no item context, so the thread is genuinely course-level
            // and is stored in the shared 'general' scope. Say that, rather than letting
            // "this screen" imply a per-assignment boundary that does not exist — QA read
            // the same list on two different assignments and reported it as a leak.
            heading={studioScope.studioSurface === 'general' ? 'Course chats' : 'Recents'}
            emptyText={
              studioScope.studioSurface === 'general'
                ? 'Course-level chats — the ones you start without an assignment or quiz open — appear here.'
                : 'Chats about this screen will appear here.'
            }
          />
        )}
      </div>

      {/* Messages */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!hasMessages && (
          // Bottom-aligned, not top. The messages area is ~720px tall on a laptop and the
          // empty state is three chips, so top-aligning left ~600px of white between them and
          // the composer — the panel read as broken and the input as missing (reported twice
          // on two different surfaces). Sitting just above the composer also puts the chips
          // where the professor is about to type, and matches how a chat fills from the bottom.
          <div className="flex min-h-full flex-col justify-end space-y-3 pb-1">
            <p className="text-sm text-muted-foreground">{copy.empty}</p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {s}
                </button>
              ))}
              {/* The one chip that ARMS Frontier instead of sending a message. Without it the
                  feature lives entirely behind an unlabelled compass, and only ~15% of
                  instructors go looking for anything in an LMS — so a professor who would
                  most want "students keep copying this" solved would never find it. Phrased
                  as the problem, not the feature name: nobody searches for "Frontier". */}
              {!isFrontier && frontierApplies(surface, assignmentId) && onModeChange && (
                <button
                  type="button"
                  onClick={() => onModeChange('frontier')}
                  className="flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Compass aria-hidden="true" className="h-3 w-3" />
                  Design one students can’t copy
                </button>
              )}
            </div>
          </div>
        )}

        {messages.map((m: UIMessage) => (
          <MessageTurn
            key={m.id}
            message={m}
            fills={fills}
            latestFillId={latestFillId}
            onUndo={handleUndo}
            onKeep={handleKeep}
            onSend={send}
          />
        ))}

        {status === 'submitted' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Athena is thinking…
          </div>
        )}
        {error && (
          <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {/* A spent budget is not a failure — say so, and don't tell them to retry
                something that cannot succeed until the window resets. Any OTHER error
                keeps the generic line rather than leaking raw provider text. */}
            {athenaLimitMessage(error.message) ?? 'Something went wrong. Try again.'}
          </p>
        )}
        {/* The SERVER's step cap tripped: Athena spent its whole budget gathering context
            and never acted (#651). Distinct from autoStopped below, which only tracks the
            CLIENT's auto-send chain — that is why the documented pause message never
            appeared for the runaway loop. One exchange can carry ~100 tool chips while
            using only the 6 server steps, because a step may fire many tool calls in
            parallel, so counting chips would not have caught it either.

            Every looped call bills against the professor's daily pool, so a turn that
            ends with nothing must SAY so rather than leave them looking at a dead
            transcript wondering whether to ask again. */}
        {stalledWithoutReply && !isLoading && (
          <p role="status" className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Athena looked things up but didn&apos;t get to an answer. Try asking again with the exact
            change you want — for example, &ldquo;set the title to X&rdquo;.
          </p>
        )}
        {/* The chain cap tripped. Say so rather than letting the chat just stop advancing —
            a silent stall is the same invisible-failure trap as a fill that renders nothing. */}
        {autoStopped && !isLoading && (
          <p role="status" className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Athena paused after several automatic steps. Send a message to carry on.
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border/60 p-2.5">
        {/* Files staged for the NEXT message (uploading → ready), each removable. */}
        {chatAttachments.attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {chatAttachments.attachments.map((a) => (
              <span
                key={a.id}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  a.status === 'error'
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : 'border-border bg-muted/40 text-foreground'
                }`}
              >
                {a.status === 'uploading' && <Loader2 className="h-3 w-3 animate-spin" />}
                <span className="max-w-40 truncate">{a.displayName}</span>
                {a.status === 'error' && <span className="sr-only">{a.error}</span>}
                {/* h-8 below md: a 20px hit box was sub-half the 44px touch guideline
                    (QA measured it unusable on 390px). Desktop keeps the tight chip. */}
                <button
                  type="button"
                  onClick={() => chatAttachments.removeAttachment(a.id)}
                  aria-label={`Remove ${a.displayName}`}
                  className="-my-1 -mr-1.5 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-5 md:w-5"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {/* The paperclip used to put a file in front of STUDENTS, and now puts it
                in front of Athena. A professor acting on the old habit would otherwise
                find out days later that nobody got the file, so say where that job
                moved — once, and only while a file is actually staged.
                Gated on KIND, not just surface: `surface` falls back to 'authoring'
                whenever no host registered (AssignmentAthenaDock:606), so a surface
                check alone printed this on the About page, the quiz studio and the
                course-level chat, none of which have that step to send anyone to. */}
            {kind && KINDS_WITH_FILES_STEP.has(kind) && (
              <p className="w-full text-xs text-muted-foreground">
                Only I can see these. To give students a file, use Add files &amp; rubrics.
              </p>
            )}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptAttribute(attachmentLimits)}
            className="hidden"
            onChange={(e) => {
              void handleAttach(e.target.files?.[0])
              if (fileInputRef.current) fileInputRef.current.value = ''
            }}
          />
          {/* A real Tooltip for the same reason the Frontier sibling below has one:
              an unlabelled icon is the discoverability risk, and native `title`
              waits ~1–2s and never fires on touch. */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading || isLoading || !chatAttachments.canAttach}
                  // Names the control only. Radix points aria-describedby at the
                  // tooltip while it is open, so a full sentence here would be
                  // read out twice. The Frontier button below follows the same rule.
                  aria-label="Attach a file"
                >
                  {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[15rem]">
                Attach a file for me to read. PDFs, slides, docs, spreadsheets and images all work.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {/* Frontier. Inline beside the attach button and built from the SAME Button
              primitive, so it is a pixel-identical sibling rather than a pill bolted under
              the composer — that second row is what made the old control read as heavy.
              While armed, a slow narrow-spectrum wash drifts BEHIND the glyph: motion
              belongs to light on a surface, not to the icon, so it never reads as a spinner
              or a notification badge. Flipping it remounts the panel (mode is in panelKey),
              hence the tooltip says so. */}
          {frontierApplies(surface, assignmentId) && onModeChange && (
            // A real Tooltip, not `title`. An unlabelled icon is the whole discoverability
            // risk here, and the native tooltip waits ~1–2s and never fires on touch — so
            // the one affordance explaining what the compass does was the one a hurried
            // professor would never see. `delayDuration` defaults to 0 in our wrapper.
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => onModeChange(isFrontier ? 'standard' : 'frontier')}
                    aria-pressed={isFrontier}
                    // STABLE label. `aria-pressed` already announces on/off, so swapping the
                    // label to "Frontier is on" made screen readers say the state twice, and
                    // the two could disagree. The label names the control; the state is
                    // aria-pressed's job.
                    aria-label="Frontier mode"
                    className={
                      isFrontier
                        ? // Armed. The tint is a LUMINANCE change across the whole button
                          // face, not just a hue swap on the border and glyph — the previous
                          // version was distinguishable only by colour, so anyone who can't
                          // separate the primary hue from grey saw no difference between on
                          // and off on the one control that changes how Athena behaves.
                          'relative overflow-hidden border-primary/50 bg-primary/10 text-primary hover:text-primary'
                        : 'relative overflow-hidden text-muted-foreground'
                    }
                  >
                    {isFrontier && <span aria-hidden="true" className="frontier-wash" />}
                    <Compass className="relative z-10 h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                {/* z-[60] because the dock itself is z-[55] (it sits above the app's z-50
                    Feedback pill), and TooltipContent's shared token is z-50 — so the
                    tooltip portaled to <body> rendered BEHIND the panel and 201 of its
                    256px were clipped by the panel's left edge. The professor saw a stub
                    reading "Frontier / stays cu", which is worse than no tooltip. Raised
                    locally rather than on the shared TooltipContent: the dock's 55 exists
                    to clear that pill, so lifting the global token would push every other
                    tooltip in the app over surfaces it currently sits under. */}
                <TooltipContent side="top" className="z-[60] max-w-64">
                  {isFrontier
                    ? 'Frontier is on — Athena asks about your field before it builds. Switching back keeps this conversation.'
                    : `Frontier: design ${isQuiz ? 'a quiz' : 'an assignment'} that stays current and resists copying.`}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(input)
              }
            }}
            rows={1}
            aria-label="Message Athena"
            placeholder={copy.placeholder}
            // Height is per-breakpoint because the placeholder wraps at mobile width and a
            // textarea does NOT grow to fit its placeholder — so the second line gets sliced
            // mid-glyph. 40px was already too short for the longest standard placeholder
            // ("Ask Athena to draft or edit questions…") and Frontier's is longer still;
            // measured scrollHeight there is 56px against a 38px box. min-h-14 (56px) is the
            // height two wrapped lines actually need, and it also buys a bigger touch target.
            // Desktop keeps 40px — the dock is wide enough there that nothing wraps.
            // No armed ring on the composer. A persistent `ring-1` on a text input is the
            // shape of a FOCUS state, so in Frontier the box looked permanently focused and
            // the real focus ring had nothing left to say. The armed state is carried by the
            // compass tint and by the placeholder, which already changes in Frontier.
            className="max-h-32 min-h-14 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring md:min-h-10"
          />
          {isLoading ? (
            <Button type="button" size="icon" variant="outline" onClick={stop} aria-label="Stop">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              onClick={() => send(input)}
              disabled={
                (!input.trim() && !chatAttachments.attachments.some((a) => a.status === 'ready')) ||
                allExhausted
              }
              aria-label="Send"
              // Point the disabled button at the reason — otherwise a screen reader
              // announces only "Send, unavailable" with no explanation anywhere.
              aria-describedby={allExhausted ? ATHENA_USAGE_NOTICE_ID : undefined}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Usage for THIS panel's pool. Renders nothing until the professor is
            near the limit, so the composer stays quiet in the normal case. This
            surface has no model picker, so it always reports on the default. */}
        <AthenaUsageNotice
          usage={usage}
          selectedModelId={DEFAULT_ATHENA_MODEL_ID}
          allExhausted={allExhausted}
          onUsageReset={refreshUsage}
          // Separates it from the composer row above, which is otherwise flush
          // against it — it should read as a caption on the composer, not as part
          // of the button row.
          className="mt-1.5"
        />
      </div>
    </div>
  )
}

function MessageTurn({
  message,
  fills,
  latestFillId,
  onUndo,
  onKeep,
  onSend,
}: {
  message: UIMessage
  fills: Record<string, { summary: string; undone: boolean; kept: boolean; applied: boolean; canUndo: boolean; canKeep: boolean }>
  /** Only this fill may still be undone — see the note at its computation. */
  latestFillId: string | null
  onUndo: (id: string) => void
  onKeep: (id: string) => void
  /** Lets a rendered tool result (the module card) speak as the professor. */
  onSend: (text: string) => void
}) {
  if (message.role === 'user') {
    const text = (message.parts as AnyPart[])
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
    // Attached files must leave a transcript record — a files-only send that
    // renders nothing reads as a swallowed message (QA finding on the About
    // surface, back when it was the only kind whose paperclip fed the model).
    const fileNames = (message.parts as AnyPart[])
      .filter((p) => p.type === 'file')
      .map((p) => (typeof (p as { filename?: unknown }).filename === 'string' ? (p as { filename: string }).filename : 'file'))
    if (!text && fileNames.length === 0) return null
    return (
      <div className="flex flex-col items-end gap-1">
        {fileNames.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
            {fileNames.map((name, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
              >
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="max-w-40 truncate">{name}</span>
              </span>
            ))}
          </div>
        )}
        {text && (
          <div className="max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">{text}</div>
        )}
      </div>
    )
  }

  // Computed once for the whole turn: the search chip needs it to decide whether to yield to
  // the disclosure, and the disclosure needs it to render.
  const sources = groundingSources(message.parts as AnyPart[])

  return (
    <div className="space-y-2">
      {(message.parts as AnyPart[]).map((part, i) => {
        if (part.type === 'text' && part.text) {
          return (
            <div
              key={i}
              // break-words + prose-a:wrap-anywhere: grounded replies quote raw source
              // URLs, and a long unbroken one sideways-scrolled the dock on mobile.
              // wrap-anywhere over break-all so a descriptive link text still breaks on
              // word boundaries and only an overflowing token is split.
              className="prose prose-sm max-w-none break-words text-sm text-foreground prose-a:wrap-anywhere prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 dark:prose-invert"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          )
        }
        // Web search FIRST: it streams as a 'dynamic-tool' part, so the tool- prefix
        // guard just below would drop it (see isWebSearchPart).
        if (isWebSearchPart(part)) {
          // A FAILED search must not read as a successful one. The other read tools
          // fold output-error into "done" because their failure is self-evident (the
          // modules just aren't in the reply); a failed search is invisible, because
          // the model fills the gap with prose the professor will trust as grounded.
          if (part.state === 'output-error') {
            return (
              <div key={i} className="flex items-center gap-2 text-xs text-warning-muted-foreground">
                <Globe className="h-3.5 w-3.5 shrink-0" />
                Couldn’t search the web — this reply isn’t sourced
              </div>
            )
          }
          // A finished search in a turn that produced citations renders as the disclosure
          // below instead, which carries the same label plus the count.
          //
          // Suppression is TURN-level, and that is the honest model rather than a shortcut:
          // grounding sources arrive for the message, not per search call, so we cannot say
          // which of two searches produced which citation. One disclosure per turn claims
          // exactly what we know; a chip per call would imply attribution we don't have.
          if (part.state === 'output-available' && sources.length > 0) return null
          return (
            <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Globe className="h-3.5 w-3.5 shrink-0" />
              {/* A finished search with NOTHING to cite has to say so. The absence of a
                  "· N sources" suffix is not a signal anyone decodes — it reads as a neutral
                  completion notice, so a guessed answer would look grounded. Matches the
                  candour of the output-error branch just above. */}
              {part.state === 'output-available'
                ? 'Searched the web — no sources to cite'
                : 'Searching the web…'}
            </div>
          )
        }

        if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) return null

        const toolName = part.type.slice('tool-'.length)

        // Fill tool → applied chip (summary + optional Undo).
        if (isFillTool(toolName)) {
          const id = part.toolCallId
          const fill = id ? fills[id] : undefined
          if (!fill) {
            // Only spin while the call is genuinely in-flight. An abandoned
            // orphan part (e.g. a duplicate call the model never completed, left
            // stuck below input-available) applied nothing, so it renders
            // nothing instead of a spinner that never resolves.
            if (part.state === 'input-streaming' || part.state === 'input-available') {
              return (
                <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying…
                </div>
              )
            }
            // The SDK rejected the model's tool INPUT against its schema, so our handler
            // never ran and there is no `fill` entry. Without this branch the part matched
            // nothing and rendered NULL — a failed write with no chip, no message and no
            // console error, visible only if the model happened to mention it in prose.
            // …but only when nothing else in this turn landed. QA watched a build where all
            // four questions saved correctly and the LAST thing on screen still read "nothing
            // was saved" — a reasonless rejected sibling call contradicting three successful
            // ones. A notice that fires next to a success is worse than no notice: it tells
            // the professor to redo work that is already done.
            if (part.state === 'output-error' || part.state === 'input-error') {
              const somethingLanded = (message.parts as AnyPart[]).some((sib) => {
                if (typeof sib.type !== 'string' || !sib.type.startsWith('tool-')) return false
                const sibId = sib.toolCallId
                return !!sibId && fills[sibId]?.applied === true
              })
              if (somethingLanded) return null
              return (
                <FillFailedNotice key={i}>
                  That change didn&apos;t go through, so nothing was saved. Ask Athena to try again.
                </FillFailedNotice>
              )
            }
            return null
          }
          if (!fill.applied) {
            return (
              <FillFailedNotice key={i}>
                <span className="font-medium">Not saved.</span> {fill.summary}
              </FillFailedNotice>
            )
          }
          return (
            <div
              key={i}
              role="status"
              className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs"
            >
              <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className={`flex-1 ${fill.undone ? 'text-muted-foreground' : 'text-foreground'}`}>
                {fill.undone ? `Reverted · ${fill.summary}` : fill.summary}
              </span>
              {/* Keep/Undo stay up until the professor acts — no timer clears them. Content
                  is already saved either way; this is a review affordance, not a gate. Only
                  the latest fill gets them (see latestFillId) — an older one either got
                  superseded by a newer edit or was already dealt with. The same two actions
                  also live inline on whatever they changed (the About canvas today), wired
                  to the identical undo()/keep() closures — so whichever one the professor
                  clicks, both places agree. */}
              {!fill.undone && !fill.kept && id === latestFillId && (
                <div className="-my-1 flex items-center gap-0.5">
                  {fill.canKeep && (
                    <button
                      type="button"
                      onClick={() => id && onKeep(id)}
                      className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 py-1.5 text-muted-foreground md:min-h-8 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Check className="h-3.5 w-3.5" /> Keep
                    </button>
                  )}
                  {fill.canUndo && (
                    <button
                      type="button"
                      onClick={() => id && onUndo(id)}
                      className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 py-1.5 text-muted-foreground md:min-h-8 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Undo
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        }

        // Read-only tool → subtle activity line.
        const meta = READONLY_TOOL_META[part.type]
        if (!meta) return null
        const Icon = meta.icon
        const done = part.state === 'output-available' || part.state === 'output-error'

        // list_modules is the one read tool with a real result to SHOW: the professor
        // picks lectures from it instead of naming them from memory.
        if (part.type === 'tool-list_modules' && part.state === 'output-available') {
          const data = asModuleCardData(part.output)
          if (data) return <QuizModuleCard key={i} data={data} onUse={onSend} />
        }

        return (
          <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {done ? meta.done : meta.running}
          </div>
        )
      })}
      {/* Citations live OUTSIDE the map: 'source-url' parts aren't tool parts, so the
          map above drops them — and a grounded turn can carry sources with no search tool
          part at all (see groundingSources), which is why this is not folded into the chip. */}
      <SourcesDisclosure sources={sources} />
    </div>
  )
}
