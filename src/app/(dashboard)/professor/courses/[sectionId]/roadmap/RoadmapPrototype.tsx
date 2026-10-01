/**
 * RoadmapPrototype — the roadmap redesign concept
 * (tmp/roadmap-ui-concepts/index_final.html), rebuilt on React Flow (@xyflow).
 *
 * React Flow owns the canvas: node positions, edges that TRACK their nodes
 * (no more hand-drawn wires / jitter), pan & zoom, and the dotted-paper
 * Background. The skeuomorphic card visuals are unchanged — each typed node
 * is the same markup/CSS as before, now rendered inside a custom React Flow
 * node and wrapped in Motion for the fade + pop entrance. Layout is computed
 * as absolute x/y coordinates (a vertical "spine" with resources fanning
 * left/right). Demo CS584 data, except the module-card titles (live).
 *
 * The hand-drawn ANNOTATION LAYER (margin notes, flags, rings, tallies …) and
 * per-node EMPHASIS (shine/breathe/outline/wash/wiggle/tada) live in
 * roadmap-annotations.tsx. The `audience` prop picks the wording set — it
 * comes from the authenticated role (professor page passes 'prof', student
 * page 'stu'), never from a UI toggle.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type CSSProperties, type FocusEvent as ReactFocusEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { Settings2, Hand, EyeOff, Maximize2, Minimize2 } from 'lucide-react'
import { motion } from 'motion/react'
import { SPRING, SPRING_POP } from '@/lib/motion'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { MaterialBody, downloadFile } from '@/components/ui/material-viewer'
import { logMaterialEvent } from '@/lib/events/material-events'
import { applySamePageLink } from '@/lib/roadmap/same-page-link'
import { setResourcePlacement } from '@/lib/roadmap/placement-actions'
import { setRoadmapNodeArchived } from '@/lib/roadmap/archive-actions'
import { stripArchived, collectArchived, isArchivedRes, withPendingPlacements, NO_WEEK, type PendingPlacement } from '@/lib/roadmap/archive'
import { unlockLabel } from '@/lib/modules/unlock'
import { HEADER_DESC, RoadmapTitleInk } from '@/components/shared/auto-roadmap/RoadmapPaper'
import { NodeCheckPanel, completionControls, useNodeCheck, type NodeCheckActions, type NodeCheckView } from './NodeCheckPanel'
import { NodeCheckReviewPanel, type NodeCheckReviewPanelProps, type NodeCheckReviewView } from './NodeCheckReviewPanel'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  PanOnScrollMode,
  ViewportPortal,
  useReactFlow,
  type Node,
  type Edge,
  type NodeChange,
  type NodeTypes,
  type NodeProps,
  type Viewport,
  type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './roadmap-prototype.css'
import type { Tier, Kind, IntKind, Resource, Session, CourseModule, RoadmapAnnotation, EmphasisSpec } from '@/lib/roadmap/prototype-adapter'
import { withMyBaking } from '@/lib/roadmap/prototype-adapter'
import { AnnotationLayer, ANNOTATION_REACH, AN_TONE, DEMO_ANNOTATIONS, DEMO_EMPHASIS, applyDemoEmphasis, rulePath, useApproachArm, emphasisClass, emphasisStyle } from './roadmap-annotations'
import { ClassLensDock, ClassAnalyticsDrawer, StudentDossierCard, JourneyOverlayContext, JOURNEY_CLASS, JOURNEY_COLOR } from './roadmap-class-lens'
import { TrackedSkillsDrawer, type TrackedSkillsSetup } from './roadmap-tracked-skills'
import { parseNodeKey, questionNumbersForSkill, type DrawerNodeKind } from '@/lib/roadmap/node-drawer'
import { useBakeWatch } from '@/lib/roadmap/use-bake-watch'
import { ARTIFACT_KIND_META, athenaNodeKey, type ArtifactState, type AthenaArtifactView, type ChecklistPayload, type FlashcardsPayload, type KnowledgeMapPayload, type PracticePayload, type StudyGuidePayload } from '@/lib/athena/artifact-kinds'
import { AthenaArtifactBody } from '@/components/student/athena/ArtifactWidgets'
import { normalizeTopicKey } from '@/lib/roadmap/journey-state'
import { freeCenterXFor, lensFraming, unlensFraming } from '@/lib/roadmap/lens-camera'
import { skillNamesMatch } from '@/lib/skills/canonical'
import { masteryTier } from '@/lib/skills/mastery'
import type { ConceptRefs } from '@/lib/roadmap/concept-refs'
import type { AutoRoadmapData } from '@/lib/validations/auto-roadmap'
import type { RoadmapDrawerAssignment, RoadmapDrawerQuestion, RoadmapDrawerSession } from '@/lib/supabase/queries'
import { getStudentJourneys, type ConceptAnalyticsData, type StudentJourneysData } from './actions'

/* ════════════════════════════════════════════════════════════════
   A · DATA — real CS584 content, hardcoded exactly as in the prototype.
       (Used as the fallback when no live `course` prop is passed. The data
       types live in the adapter — the single source of truth shared with
       the AutoRoadmapData → prototype mapping.)
   ════════════════════════════════════════════════════════════════ */
const M = (k: Kind, t: string, s: string, x: Partial<Resource> = {}): Resource => ({ k, t, s, st: 'todo', ...x })
const Q = (t: string, st: 'published' | 'draft'): Resource => ({ k: 'quiz', t, s: st === 'published' ? 'Published' : 'Draft — hidden from students', st: 'todo' })
const A = (t: string, st: 'published' | 'scheduled' | 'draft'): Resource => ({ k: 'assignment', t, s: st === 'published' ? 'Published' : st === 'scheduled' ? 'Scheduled' : 'Draft', st: 'todo' })
/* demo facepile — only for the standalone COURSE fallback; real data carries its
   own roster (undefined → no facepile, never these stand-ins). */
const DEMO_FACES: Session['attendees'] = { initials: ['EC', 'MJ', 'PP', 'AR'], total: 14 }
const S = (t: string, s: string, x: Partial<Session> = {}): Session => ({ t, s, attendees: DEMO_FACES, ...x })

const COURSE: CourseModule[] = [
  { title: 'Course Information', pct: 7,
    materials: [ M('lecture', 'Course Project Guidelines', 'PDF · 20 pages', { skills: [['Low-Rank Adaptation', 'shaky'], ['Membership inference attacks', 'weak'], ['Differential privacy', 'none']], more: 2 }), M('lecture', 'Final Report — Format Guide', 'PDF · 2 pages', { skills: [['Ablation study', 'strong'], ['Quantitative evaluation', 'shaky'], ['Error analysis', 'weak']], more: 1 }),
      M('lecture', '(untitled)', 'PDF · 3 pages'), M('lecture', 'Midterm — Sample Exam', 'PDF · 1 page', { skills: [['NumPy broadcasting rules', 'strong'], ['Sigmoid activation function', 'weak'], ['Cross-entropy loss', 'shaky']], more: 3 }),
      M('note', 'Welcome to CS584', 'Note'), M('link', 'Course Discussion Board', 'edstem.org'),
      M('lecture', 'Syllabus — CS584', '6 pages · demo', { fmt: 'DOC' }), M('lecture', 'Grade Weights Calculator', 'template · demo', { fmt: 'XLS' }) ],
    quizzes: [ Q('Midterm Review (Mixed Bank)', 'published') ], assignments: [] },
  { title: 'Introduction to NLP', pct: 13, live: true,
    materials: [ M('lecture', 'Lecture 1: Introduction to NLP', 'PDF · 81 pages'), M('video', 'Stanford CS224N — Lecture 1: Intro & Word Vectors', 'Video', { src: 'youtube', dur: '1:24:27' }),
      M('note', 'Before our first class', 'Note'),
      M('lecture', 'Week 1 Slides — Course Intro', '24 slides · demo', { fmt: 'PPT' }) ],
    quizzes: [ { ...Q('Intro to NLP — AI Quiz', 'published'), skills: [['Part-of-speech tagging', 'weak'], ['Stochastic gradient descent', 'shaky'], ['Tokenization', 'strong']] } ], assignments: [] },
  { title: 'Machine Learning Foundations', pct: 0,
    materials: [ M('lecture', 'Notes: Logistic Regression & Gradient Descent', 'PDF'), M('lecture', 'Notes: Neural Networks', 'PDF'),
      M('video', '3Blue1Brown — But what is a neural network?', 'Video', { src: 'youtube', dur: '19:13' }), M('video', 'Karpathy — Intro to backpropagation (micrograd)', 'Video', { src: 'youtube', dur: '2:25:52' }),
      M('video', 'ACL Talks — Attention Mechanisms: A Retrospective', 'Video', { src: 'vimeo', dur: '31:04' }),
      M('video', 'Guest Lecture — Scaling Laws (recording)', 'recording · demo', { fmt: 'MP4', dur: '48:12' }) ],
    quizzes: [], assignments: [] },
  { title: 'Language Modeling', pct: 17,
    materials: [ M('lecture', 'Lecture 2: Language Modeling', 'PDF · 46 pages'), M('reference', 'Bengio et al. — A Neural Probabilistic Language Model', 'jmlr.org') ],
    quizzes: [ Q('Adaptive Diagnostic — NLP', 'published') ], assignments: [],
    sessions: [ S('Lecture 2: Language Modeling', 'ended Jul 11') ] },
  { title: 'Word Vectors', pct: 10, ongoing: true,
    materials: [ M('lecture', 'Lecture 3: Word Vectors', 'PDF · 58 pages', { skills: [['Skip-gram model', 'strong'], ['Cosine similarity', 'none'], ['Negative sampling', 'shaky']], more: 1 }), M('lecture', 'Notes: word2vec', 'PDF'),
      M('reference', 'Mikolov et al. — Efficient Estimation of Word Representations', 'arXiv · 1301.3781'), M('link', 'The Illustrated Word2vec', 'jalammar.github.io'),
      M('image', 't-SNE map of the word2vec space', 'PNG · 1600×1200', { st: 'done' }) ],
    quizzes: [], assignments: [ A('A1: Text Classification with Word Vectors', 'published') ] },
  { title: 'Recurrent Neural Networks', pct: 0,
    materials: [ M('lecture', 'Lecture 4: RNNs and Beyond', 'PDF · 64 pages'), M('link', 'Understanding LSTM Networks (colah’s blog)', 'colah.github.io') ],
    quizzes: [ Q('Pop Quiz — RNNs', 'draft') ],
    assignments: [ A('Notebook: Build a Bigram LM', 'published'), A('Essay: From RNNs to Transformers', 'published') ],
    sessions: [ S('Lecture 4: RNNs and Beyond', 'ended Jul 12', { ints: [['poll', '2 polls']] }) ] },
  { title: 'Sequence-to-Sequence & Attention', pct: 0,
    materials: [ M('lecture', 'Lecture 5: Seq2Seq and Attention', 'PDF · 72 pages'), M('reference', 'Sutskever et al. — Sequence to Sequence Learning', 'arXiv · 1409.3215'),
      M('reference', 'Bahdanau et al. — NMT by Jointly Learning to Align and Translate', 'arXiv · 1409.0473') ],
    quizzes: [], assignments: [],
    sessions: [ S('Lecture 5: Seq2Seq and Attention', 'ended Jul 14', { ints: [['qa', '2 questions · 1 answered']] }) ] },
  { title: 'Transformers', pct: 0,
    materials: [ M('lecture', 'Lecture 6: Transformers', 'PDF · 66 pages', { skills: [['Self-Attention', 'shaky'], ['Multi-Head Attention', 'weak'], ['Positional Encoding', 'none']], more: 1 }), M('reference', 'Vaswani et al. — Attention Is All You Need', 'arXiv · 1706.03762'),
      M('link', 'The Illustrated Transformer', 'jalammar.github.io'), M('video', '3Blue1Brown — Attention in transformers, step by step', 'Video', { src: 'youtube', dur: '26:10' }),
      M('note', 'This is the big one', 'Note'), M('note', 'Re-read §3 before Thursday’s deep-dive', 'Note'),
      M('image', 'Annotated Transformer architecture', 'JPG · 1920×1080', { fmt: 'JPG' }),
      M('lecture', 'attention-starter-code.zip', 'starter code · demo', { fmt: 'ZIP' }) ],
    quizzes: [ Q('Transformers Quiz 1', 'published') ],
    assignments: [ A('Reading Response: “Attention Is All You Need”', 'published'), A('Oral Exam: Explain Attention', 'published') ],
    sessions: [ S('Lecture 6: Transformers', 'ended Jul 13', { ints: [['lquiz', '1 live quiz · 6 submissions']] }),
      S('Lecture 6: Transformers Deep Dive', 'scheduled · today', { sched: true, mon: 'JUL', day: 17 }) ] },
  { title: 'Pretraining & Post-training', pct: 0,
    materials: [ M('lecture', 'Lecture 7: Pretraining and Post-training', 'PDF · 88 pages'), M('lecture', 'Lecture 8: More Post-training', 'PDF · 54 pages'),
      M('reference', 'Devlin et al. — BERT', 'arXiv · 1810.04805'), M('reference', 'Ouyang et al. — InstructGPT (RLHF)', 'arXiv · 2203.02155'),
      M('video', 'Karpathy — Let’s build GPT: from scratch, in code', 'Video', { src: 'youtube', dur: '1:56:20' }) ],
    quizzes: [ Q('Week 8 Quiz', 'draft') ], assignments: [] },
  { title: 'Reasoning & Agents', pct: 0,
    materials: [ M('lecture', 'Lecture 9: Reasoning and Agents', 'PDF · 62 pages'), M('reference', 'Wei et al. — Chain-of-Thought Prompting', 'arXiv · 2201.11903'),
      M('reference', 'Yao et al. — ReAct: Reasoning + Acting', 'arXiv · 2210.03629') ],
    quizzes: [], assignments: [] },
  { title: 'Syntax & Discourse', pct: 0,
    materials: [ M('lecture', 'Lecture 10: Syntax and Discourse', 'PDF · 48 pages'), M('reference', 'Jurafsky & Martin — Speech and Language Processing (3rd ed.)', 'web.stanford.edu') ],
    quizzes: [], assignments: [] },
  { title: 'Quiz Uploads', pct: 0, draft: true,
    materials: [ M('lecture', 'midterm2010f', 'PDF') ], quizzes: [], assignments: [] },
]
const UNPLACED: Resource[] = [
  Q('Quick Check — Word Vectors', 'draft'), Q('Imported NLP MCQs', 'draft'), Q('Transformers Quiz 1 (Copy)', 'draft'), Q('Untitled quiz', 'draft'),
  A('A3: Fine-tuning a Transformer', 'scheduled'), A('A2: Language Model Perplexity', 'draft'), A('Untitled document', 'draft'),
]
/* the queued interaction renders as a compact chip (glyph + name, ellipsized),
   not a prose sentence — long names truncate instead of wrapping the card */
const LIVE = { t: 'Lecture 1: Introduction to NLP', queued: { kind: 'poll' as IntKind, name: 'Attendance' } }
/* demo off-map bench: the draft "Quiz Uploads" module's files (fallback when no live data) */
const DEMO_QUIZ_UPLOADS: Resource[] = COURSE.filter((m) => m.draft).flatMap((m) => m.materials)

/* ════════════════════════════════════════════════════════════════
   B · SHARED CONSTANTS & HELPERS
   ════════════════════════════════════════════════════════════════ */
/* mastery tiers — weak <60 · shaky 60–79 · strong ≥80 · none = no signal */
const TIER: Record<Tier, string> = { weak: '#ef4444', shaky: '#f59e0b', strong: '#10b981', none: '#94a3b8' }
/* kind hue lookup for inline styles */
const KIND_COLOR: Record<string, string> = { lecture: 'var(--c-lecture)', quiz: 'var(--c-quiz)', assignment: 'var(--c-assignment)', session: 'var(--c-session)' }
/* universal file-format colors (Drive/Finder convention) */
const FMT_COLOR: Record<string, string> = { PDF: '#e5484d', PPT: '#d9730d', DOC: '#3b82f6', XLS: '#22a06b', ZIP: '#ca8a04', PNG: '#d946ef', JPG: '#d946ef', TXT: '#64748b', MP4: '#f43f5e', MOV: '#f43f5e', WEBM: '#f43f5e' }
const MAX_HOVER_SKILLS = 3 /* named chips on hover; rest → +N pile */

const cssVars = (v: Record<string, string | number>) => v as CSSProperties
const mpct = (d: number, t: number) => (t ? Math.round((d / t) * 100) : 0)
/* off-map cards carry no mastery yet (they're unplaced) — drop the skill pill + hover cloud */
const bareCard = (r: Resource): Resource => (r.skills ? { ...r, skills: undefined, more: undefined } : r)

/* Open an external target from stored, professor-supplied content. Only http(s)
   ever navigates; a scheme-less value ("example.com") is treated as https; any
   other scheme (javascript:/data:/…) is refused — the content is untrusted and
   this renderer is bound for the student view. */
/* Open one of OUR OWN routes in a new tab. Kept apart from openExternal, which
   treats a scheme-less value as a bare host and would turn `/professor/courses/…`
   into `https:///professor/courses/…`. Same-origin app paths only — the leading
   `/` must not be followed by another `/` or a `\\`, both of which the URL
   parser reads as protocol-relative and resolves off-site. */
function openAppPath(path: string) {
  if (!/^\/(?![/\\])/.test(path)) return
  window.open(path, '_blank', 'noopener')
}

function openExternal(url: string) {
  const u = url.trim()
  if (!u) return
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(u)
  const target = hasScheme ? (/^https?:\/\//i.test(u) ? u : null) : `https://${u}`
  if (target) window.open(target, '_blank', 'noopener')
}

/* recognizable marks (Jakob's law): YouTube logo, address-bar padlock */
const YTLogo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor"><rect x="1" y="4.5" width="22" height="15" rx="4.5" /><path d="m9.8 9 6.6 3-6.6 3z" fill="#fff" /></svg>
)
const VimeoLogo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor"><rect x="1" y="5.5" width="22" height="13" rx="6.5" /><path d="m10 9 5.5 3-5.5 3z" fill="#fff" /></svg>
)
const LockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11" /></svg>
)
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m10 8 6 4-6 4z" /></svg>
)
/* two hill ranges for the polaroid window (stretched to fit via preserveAspectRatio) */
const Hills = () => (
  <svg viewBox="0 0 100 36" preserveAspectRatio="none"><path d="M0 36 26 6 50 36Z" fill="#79c1a4" /><path d="M30 36 58 10 74 26 84 16 100 32V36Z" fill="#2f9e6e" /></svg>
)

/* ════════════════════════════════════════════════════════════════
   C · CARD VISUALS — the same skeuomorphic markup as the prototype;
       these render INSIDE React Flow custom nodes (section D).
   ════════════════════════════════════════════════════════════════ */

/* C.1 skill badge — collapsed "n skills" pill + mastery-mix donut, and the
   hover cloud (≤3 named chips; overflow → "· +N more" inside the last chip) */
function SkillBadge({ r }: { r: Resource }) {
  if (!r.skills) return null
  const counts: Record<Tier, number> = { strong: 0, shaky: 0, weak: 0, none: r.more || 0 }
  r.skills.forEach(([, t]) => { counts[t]++ })
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  let acc = 0
  const stops = (['strong', 'shaky', 'weak', 'none'] as Tier[]).filter((k) => counts[k]).map((k) => {
    const from = (acc / total) * 360
    acc += counts[k]
    return `${TIER[k]} ${from}deg ${(acc / total) * 360}deg`
  }).join(', ')
  const shown = r.skills.slice(0, MAX_HOVER_SKILLS)
  const extra = (r.skills.length - shown.length) + (r.more || 0)
  return (
    <>
      <span className="skpill"><b className="donut" style={{ background: `conic-gradient(${stops})` }} />{total} skills</span>
      <span className="skillcloud">
        {shown.map(([n, t], i) => (
          <i key={n}>
            <b style={{ background: TIER[t] }} /><span className="sname" title={n}>{n}</span>
            {i === shown.length - 1 && extra > 0 ? <span className="xmore">+{extra} more</span> : null}
          </i>
        ))}
      </span>
    </>
  )
}

/* C.2 typed resource cards — <Res> dispatches on r.k */
const St = () => <span className="st" />

function NodeDocument({ r, cls, style }: { r: Resource; cls: (mods?: string) => string; style: CSSProperties }) {
  const fmt = r.fmt || 'PDF'
  const sub = r.s.replace(/^PDF(\s·\s)?/, '') || 'document'
  /* real data sets `slides` from useAsSlides; demo content falls back to the title. */
  if (r.slides ?? /lecture/i.test(r.t)) { /* lecture deck → cover-preview card */
    // Prefer the real count; fall back to parsing the subtitle (demo data encodes
    // it only in the string). Format-agnostic — works for PDF, PPT/PPTX, DOC, …
    const pages = r.pages ?? (Number((r.s.match(/(\d+)\s*(?:pages?|slides?)/i) || [])[1]) || undefined)
    // the cover already shows "1 / N" + the format badge, so drop the redundant
    // "FMT · N pages/slides" from the text line (keep trailing flavour like "· demo").
    const deckSub = r.s.replace(/^(?:[A-Za-z]{2,4}\s·\s)?\d+\s+(?:pages?|slides?)\s*·?\s*/i, '').trim()
    return (
      <div className={cls('vB')} style={style}>
        <div className="cover">
          <i className="l1" /><i className="l2" /><i className="l3" /><i className="l2 short" />
          <b className="cfmt" style={cssVars({ '--f': FMT_COLOR[fmt] || '#64748b' })}>{fmt}</b>
          {/* Coverage when we know it ("18 / 30" = where the class actually got
              to), else the plain first-page badge. */}
          {pages ? <b className="cpg">{r.covered ?? 1} / {pages}</b> : null}
        </div>
        <div className="vbody"><div className="t">{r.t}</div><div className="s"><em>lecture</em>{deckSub ? ` ${deckSub}` : ''}</div></div>
        <SkillBadge r={r} /><St />
      </div>
    )
  }
  /* any other upload → generic file with the portrait-page thumb */
  return (
    <div className={cls()} style={style}>
      <span className="page"><i /><i /><i /><b style={cssVars({ '--f': FMT_COLOR[fmt] || '#64748b' })}>{fmt}</b></span>
      <div><div className="t">{r.t}</div><div className="s"><em>file</em> {sub}</div></div>
      <SkillBadge r={r} /><St />
    </div>
  )
}
function NodeVideo({ r, cls, style }: { r: Resource; cls: (mods?: string) => string; style: CSSProperties }) {
  const dur = r.dur ? <b className="dur">{r.dur}</b> : null
  /* uploaded video file (no embed source) → player thumb + format ribbon */
  if (!r.src) {
    const fmt = r.fmt || 'MP4'
    return (
      <div className={cls()} style={style}>
        <div className="thumb"><PlayIcon />{dur}</div>
        <div className="vmeta">
          <span className="vfmt" style={cssVars({ '--f': FMT_COLOR[fmt] || '#64748b' })}>{fmt}</span>
          <div><div className="t">{r.t}</div><div className="s"><em>video</em> {r.s}</div></div>
        </div>
        <St />
      </div>
    )
  }
  /* branded embed → YouTube (red) or Vimeo (blue). A "Channel — Title" name
     splits into an avatar + channel byline; a plain title (the common case for
     a pasted link) shows just the title + source badge, no invented channel. */
  const vimeo = r.src === 'vimeo'
  const source = vimeo ? 'Vimeo' : 'YouTube'
  const [maybeChannel, ...restT] = r.t.split(' — ')
  const channel = restT.length ? maybeChannel : ''
  const title = restT.length ? restT.join(' — ') : r.t
  return (
    <div className={cls(vimeo ? 'vimeo' : 'yt')} style={style}>
      <div className="thumb">{vimeo ? <VimeoLogo /> : <YTLogo />}{dur}</div>
      <div className="vmeta">
        {channel ? <span className="avatar">{channel[0]}</span> : null}
        <div><div className="t">{title}</div><div className="s">{channel ? `${channel} · ` : ''}{source}</div></div>
      </div>
      <St />
    </div>
  )
}
function NodeLink({ r, cls, style }: { r: Resource; cls: (mods?: string) => string; style: CSSProperties }) {
  return (
    <div className={cls()} style={style}>
      <div className="win">
        <div className="chrome"><i /><i /><i /><span className="addr"><LockIcon /><span>{r.s}</span></span></div>
        <div className="trow"><span className="fav">🔗</span><div className="t">{r.t}</div><span className="arr">↗</span></div>
      </div>
      <St />
    </div>
  )
}
function NodeReference({ r, cls, style }: { r: Resource; cls: (mods?: string) => string; style: CSSProperties }) {
  const [venue, ...rest] = r.s.split(' · ')
  return (
    <div className={cls()} style={style}>
      <div>
        <div className="t">{r.t}</div>
        <div className="s"><span className={`venue ${venue === 'arXiv' ? 'arxiv' : ''}`}>{venue}</span> {rest.join(' · ')}</div>
      </div>
      <St />
    </div>
  )
}
function NodeQuiz({ r, cls, style }: { r: Resource; cls: (mods?: string) => string; style: CSSProperties }) {
  return (
    <div className={cls()} style={style}>
      <div className="qbody">
        <div className="qk">QUIZ</div><div className="t">{r.t}</div>
        <div className="form">
          <label><i className="rd on" /><span className="ln" style={{ width: '68%' }} /></label>
          <label><i className="rd" /><span className="ln" style={{ width: '52%' }} /></label>
          <label><i className="rd" /><span className="ln" style={{ width: '60%' }} /></label>
        </div>
        <div className="s">{r.s}</div>
      </div>
      <SkillBadge r={r} /><St />
    </div>
  )
}
function NodePaper({ r, cls, style }: { r: Resource; cls: (mods?: string) => string; style: CSSProperties }) {
  /* assignment (copybook) & any fallback */
  return (
    <div className={cls()} style={style}>
      <div><div className="t">{r.t}</div><div className="s"><em>{r.k}</em> {r.s}</div></div>
      <St />
    </div>
  )
}
/* image upload → an instant photo: polaroid frame, sun+hills window, format
   badge + pixel size, handwritten caption in the chin */
function NodeImage({ r, cls, style }: { r: Resource; cls: (mods?: string) => string; style: CSSProperties }) {
  const fmt = r.fmt || 'PNG'
  const dims = (r.s.match(/\d+×\d+/) || [])[0]
  /* a real uploaded image fills the frame (via CSS background — dodges the
     next/no-img-element rule); otherwise the stylized sun+hills placeholder. */
  const photoStyle = r.img
    ? cssVars({ backgroundImage: `url("${r.img}")`, backgroundSize: 'cover', backgroundPosition: 'center' })
    : undefined
  return (
    <div className={cls()} style={style}>
      <div className={`photo${r.img ? ' real' : ''}`} style={photoStyle}>
        {r.img ? null : <Hills />}
        <b className="ifmt" style={cssVars({ '--f': FMT_COLOR[fmt] || '#64748b' })}>{fmt}</b>
        {dims ? <b className="idim">{dims}</b> : null}
      </div>
      <div className="cap"><div className="t">{r.t}</div></div>
      <St />
    </div>
  )
}

/* calm mode: every kind becomes the same quiet card — title + KIND · subtitle,
   the whole card washed in a tint of its kind hue (no skeuomorphic objects) */
function NodeSimple({ r }: { r: Resource }) {
  const isDeck = r.slides ?? /lecture/i.test(r.t)
  const label = r.k === 'lecture' && !isDeck ? 'file' : r.k
  /* A deck's coverage fraction ("18 / 30") lives in `covered`/`pages`, and only
     the cover badge renders those — calm mode drops the cover, which silently
     dropped the one number the coverage engine exists to derive. Say it in the
     subtitle instead, replacing the redundant "N pages" the badge stood in for. */
  const deckFraction = r.k === 'lecture' && isDeck && r.pages
    ? `${r.covered ?? 1} / ${r.pages}`
    : null
  const sub = r.k === 'video'
    ? [r.src === 'youtube' ? 'YouTube' : r.src === 'vimeo' ? 'Vimeo' : 'Upload', r.dur].filter(Boolean).join(' · ')
    : deckFraction
      ? [r.s.replace(/\d+\s+(?:pages?|slides?)\s*·?\s*/i, '').replace(/\s*·\s*$/, '').trim(), deckFraction]
          .filter(Boolean).join(' · ')
      : r.s
  return (
    <div className={`res plain ${r.st}${r.hidden ? ' hidden-from-students' : ''}`} style={cssVars({ '--c': `var(--c-${r.k})` })}>
      <div><div className="t">{r.t}</div><div className="s"><em>{label}</em> {sub}</div></div>
      <SkillBadge r={r} /><St />
    </div>
  )
}

function Res({ r, calm }: { r: Resource; calm?: boolean }) {
  /* `hidden` rides on the shared class list so every card kind picks it up at
     once: faded + an eye-off glyph (see .res.hidden in roadmap-prototype.css).
     Both, not just the fade — transparency alone reads as "de-emphasised", which
     is not the same claim as "students cannot see this". Professor-only; the
     adapter never sets it for a student. */
  const hiddenCls = r.hidden ? ' hidden-from-students' : ''
  if (calm) return <NodeSimple r={r} />
  const style = cssVars({ '--c': `var(--c-${r.k})` })
  const cls = (mods = '') => `res k-${r.k} ${r.st} ${mods}${hiddenCls}`.trim()
  const props = { r, cls, style }
  switch (r.k) {
    case 'lecture': return <NodeDocument {...props} />
    case 'video': return <NodeVideo {...props} />
    case 'link': return <NodeLink {...props} />
    case 'reference': return <NodeReference {...props} />
    case 'quiz': return <NodeQuiz {...props} />
    case 'image': return <NodeImage {...props} />
    default: return <NodePaper {...props} />
  }
}

/* C.3 module card interior (the `.core`) */
function ModuleCardInner({ m, open, weekNumber }: { m: CourseModule; open: boolean; weekNumber: number | null }) {
  /* Not open yet: title, week, and when it opens — nothing else. There is no
     content to summarise (the loader stripped it) and no percentage that would be
     true, so the card deliberately stops here instead of showing "0%" or "empty
     module", both of which read as a course that lost its material. */
  if (m.locked) {
    const opens = unlockLabel(m.opensAt)
    return (
      <div className="core locked">
        <div className="k">{weekNumber != null ? `WEEK ${weekNumber}` : 'MODULE'}</div>
        <div className="dhead">
          <h3>{m.title}</h3>
          {/* suppressHydrationWarning: the date is formatted in the reader's own
              timezone, which can differ from the server's by a day near midnight. */}
          <span className="lockb" suppressHydrationWarning>{opens ?? 'Not open yet'}</span>
        </div>
      </div>
    )
  }
  // Both excluded cases say WHY the percentage reads "—"; without a reason on
  // the card the professor's fair reading is that the number is broken.
  const kicker = m.draft
    ? 'DRAFT MODULE — HIDDEN FROM STUDENTS'
    : m.skipped
      ? 'NOT COVERING — LEFT OUT OF PROGRESS'
      : m.excluded
        ? 'NOTHING TO TRACK YET — NOT COUNTED'
        : weekNumber != null ? `WEEK ${weekNumber}` : 'MODULE'
  // Real per-type "done" counts from each item's own status — never a blend of
  // the module's overall %, which would (wrongly) spread completion evenly across
  // types (e.g. 2 done lectures + 0 done quizzes ≠ "1 done of each").
  const doneOf = (rs: Resource[]) => rs.filter((r) => r.st === 'done').length
  /* The live room counts here even though it renders as the pulsing LIVE node
     rather than a session tile: the coverage engine counts every placed
     live_session in this module's percentage, so leaving it out of the tally made
     the card's own numbers and its percentage describe different sets — a week
     with one class, currently live, showed no session at all. */
  const sess = [...(m.sessions || []), ...(m.liveRoom ? [m.liveRoom] : [])]
  // Notes are informational, not completable — excluded from both the total and
  // the done tally. Supplementary material follows the same rule for a
  // PROFESSOR (nothing they deliver), but for a student it IS completable, so
  // `tickable` keeps it in the total from the start — otherwise ticking one
  // would grow the denominator it belongs to.
  const mats = m.materials.filter((r) => r.k !== 'note' && (r.st || r.tickable))
  const types = ([
    ['materials', 'lecture', mats.length, doneOf(mats)],
    ['quizzes', 'quiz', m.quizzes.length, doneOf(m.quizzes)],
    ['assignments', 'assignment', m.assignments.length, doneOf(m.assignments)],
    // Done = it has actually finished: neither still upcoming nor mid-class.
    ['sessions', 'session', sess.length, sess.filter((s) => !s.sched && !s.live).length],
  ] as [string, string, number, number][]).filter(([, , c]) => c)
  return (
    <div className={`core${open ? ' open' : ''}${m.ongoing ? ' ongoing' : ''}`}>
      <div className="k">{kicker}</div>
      {/* An excluded module has no honest percentage to show — a bare "0%" would
          read as failure when the point is that it isn't being counted at all. */}
      <div className="dhead">
        <h3>{m.title}</h3>
        {m.excluded
          ? <b className="opct zero" title="Not counted toward progress" aria-label="Not counted toward progress">—</b>
          : <b className={`opct${m.pct ? '' : ' zero'}`}>{m.pct}%</b>}
      </div>
      {types.length > 0 ? (
        <div className="rule">
          {types.map(([, k, c, d]) => (
            <b key={k} style={cssVars({ '--tc': KIND_COLOR[k], '--n': c })}><i style={cssVars({ '--w': `${mpct(d, c)}%` })} /></b>
          ))}
        </div>
      ) : null}
      {types.length > 0 ? (
        <div className="cts">
          {types.map(([nm, k, c, d]) => (
            <span key={k}><i style={{ background: KIND_COLOR[k] }} /><b>{d}/{c}</b> {nm}</span>
          ))}
        </div>
      ) : <div className="meta">empty module</div>}
    </div>
  )
}

/* C.4 sticky note (lives on the spine, below its module card) */
function NoteCard({ note, calm, i, author }: { note: Resource; calm: boolean; i: number; author: string }) {
  const body = <div><div className="t">{note.t}</div><div className="s"><em>note</em> {author}</div></div>
  if (calm) return <div className="res plain mini" style={cssVars({ '--c': 'var(--c-note)' })}>{body}</div>
  return <div className="res k-note mini" style={cssVars({ '--c': 'var(--c-note)', transform: `rotate(${i % 2 ? 2 : -2}deg)` })}>{body}</div>
}

/* C.5 sessions & live node (lc_rooms) */
const INT_GLYPH: Record<IntKind, React.ReactNode> = {
  poll: <span className="ig pollg"><i style={{ height: 5 }} /><i style={{ height: 10 }} /><i style={{ height: 7 }} /></span>,
  lquiz: <span className="ig quizg" />,
  qa: <span className="ig qag">Q</span>,
}
const IntRows = ({ ints }: { ints?: [IntKind, string][] }) => ints?.length ? (
  <div className="irows">
    {ints.map(([k, label]) => <span key={k} className={`irow i-${k}`}>{INT_GLYPH[k]}{label}</span>)}
  </div>
) : null

/* attendee facepile — real initials + a "+N" for the overflow, coloured by a
   fixed palette. Renders nothing when there's no roster (e.g. a live room no one
   has joined yet), so we never fake a crowd. */
const FACE_COLORS = ['#7c5cd6', '#2f9e6e', '#d6708b', '#4a6fd0']
function Facepile({ people }: { people?: Session['attendees'] }) {
  if (!people || people.total === 0) return null
  const rest = people.total - people.initials.length
  // The initials are decorative letter-salad to a screen reader; surface the
  // real head-count as the label and hide the chips.
  return (
    <div className="facepile" role="img" aria-label={`${people.total} ${people.total === 1 ? 'person' : 'people'}`}>
      {people.initials.map((ini, i) => (
        <i key={i} aria-hidden style={cssVars({ '--a': FACE_COLORS[i % FACE_COLORS.length] })}>{ini}</i>
      ))}
      {rest > 0 ? <i className="more" aria-hidden>+{rest}</i> : null}
    </div>
  )
}

function SessionCard({ s }: { s: Session }) { /* held / scheduled room — the live node's shape, not live */
  /* the ENDED/SCHEDULED pill already states the status — drop that leading word
     from the subtitle so it isn't said twice (keeps any trailing date). */
  const sub = s.s.replace(/^(ended|scheduled)\b[\s·—-]*/i, '').trim()
  return (
    <div className={`live-node session ${s.sched ? 'sched' : 'ended'}`}>
      {s.sched ? (
        <span className="cal"><b>{s.mon}</b><i>{s.day}</i></span>
      ) : (
        <Facepile people={s.attendees} />
      )}
      <div className="body"><div className="t">{s.t}</div>{sub ? <div className="s">{sub}</div> : null}<IntRows ints={s.ints} /></div>
      <span className="spill">{s.sched ? 'SCHEDULED' : 'ENDED'}</span>
    </div>
  )
}
function LiveCard({ room }: { room?: Session }) { /* the room that is live right now */
  const title = room?.t ?? LIVE.t
  // Real data: the room's own roster (empty → no facepile). Standalone demo (no
  // room object at all): the stand-in faces so the concept still reads.
  const people = room ? room.attendees : DEMO_FACES
  return (
    <div className="live-node">
      <Facepile people={people} />
      <div>
        <div className="t">{title}</div>
        {room?.ints?.length ? <IntRows ints={room.ints} /> : room ? null : (
          <div className="irows">
            <span className={`irow i-${LIVE.queued.kind}`}>{INT_GLYPH[LIVE.queued.kind]}<span className="iname">{LIVE.queued.name}</span><span className="iq">queued</span></span>
          </div>
        )}
        {/* ↗ signals it opens the broadcaster in a new tab (matches link/video cards) */}
        <div className="join">Join the room ↗</div>
      </div>
      <span className="live-pill"><i />LIVE</span>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════
   D · REACT FLOW NODES — one custom node per kind. Each wraps its card
       in a Motion div for the fade + pop entrance; React Flow measures
       the (transform-free) layout box, so edges anchor without jitter.
   ════════════════════════════════════════════════════════════════ */
type ModuleData = { m: CourseModule; idx: number; open: boolean; weekNumber: number | null }
type ResourceData = { r: Resource; calm: boolean; side: 'L' | 'R'; jit: number; delay: number }
type NoteData = { note: Resource; calm: boolean; i: number; delay: number; author: string }
type SessionData = { s: Session }
type LiveData = { room?: Session }
/** One Athena margin note. `j` = position within its module's flock (drives
 *  the entrance stagger). */
type AthenaData = { a: AthenaArtifactView; j: number }
type SpinePhase = 'todo' | 'prog' | 'done'
type SpineData = { height: number; segments: { height: number; phase: SpinePhase }[] }
/* a divider the professor authored: an in-module one across the materials lane,
   or a module-level one across the whole map. `w` is the node's width — the pen
   line is drawn in its own viewBox, so it needs the span up front. */
type DividerData = { title: string; w: number }
/* the calendar's own line across the map — where "now" falls between modules.
   Professor view only, and only while unplaced work hangs off it. */
type TodayData = { label: string; w: number }
/* an unplaced quiz/assignment, waiting loose near the today-line. An ordinary
   card — `side` only says which column it snaps into when dragged onto a week
   (quizzes/assignments left, materials right, like every placed card). */
type UnplacedData = { r: Resource; calm: boolean; side: 'L' | 'R' }
/** Which column a card belongs in — the map's one rule, applied to a card that
 *  has no module yet so a drag lands it where its placed siblings live. */
const sideFor = (r: Resource): 'L' | 'R' => (r.k === 'quiz' || r.k === 'assignment' ? 'L' : 'R')
/** The empty place a column holds open for a card being dragged onto it. `kind`
 *  decides WHERE in that column: a lane is built as quizzes-then-assignments, so
 *  a quiz can only ever land at the end of the quizzes — that structure is the
 *  order, there is no per-card position stored to insert between them. */
type DropSlot = { moduleIdx: number; side: 'L' | 'R'; h: number; kind: Kind }
type DropSlotData = { h: number }

/* shared entrance — opacity + gentle pop (transform only, so layout stays
   stable). `delay` staggers a module's resources so they fade in one-by-one
   rather than all at once when the module expands. */
const rise = (delay = 0) => ({
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  transition: { ...SPRING, delay },
})
/* Notes get a springier "expand" pop than the shared rise, matching the sticky
   note's bounce in the prototype. SPRING_POP is the house token for exactly
   this: overshoot, but only where the motion carries momentum. */
const notePop = (delay = 0) => ({
  initial: { opacity: 0, scale: 0.7 },
  animate: { opacity: 1, scale: 1 },
  transition: { ...SPRING_POP, delay },
})
const HIDDEN_HANDLE = { pointerEvents: 'none' as const }

const NO_MY_BAKING: Readonly<Record<string, true>> = {}

/* node emphasis (shine/breathe/outline/wash/wiggle/tada) is a property ANY
   node can carry (`em`/`emTone` on its data object) — the wrapper takes the
   em-* class + tone var, CSS routes it onto the card element itself, and the
   effect arms when the node scrolls into view (useEmphasis). */
function ModuleFlowNode({ data }: NodeProps) {
  const d = data as unknown as ModuleData
  const emRef = useRef<HTMLDivElement>(null)
  const armed = useApproachArm(emRef, !!d.m.em)
  return (
    <motion.div ref={emRef} className={`rf-node${emphasisClass(d.m.em, armed)}`} style={emphasisStyle(d.m.em, d.m.emTone)} {...rise()}>
      <Handle type="source" position={Position.Left} id="l" isConnectable={false} style={HIDDEN_HANDLE} />
      <ModuleCardInner m={d.m} open={d.open} weekNumber={d.weekNumber} />
      <Handle type="source" position={Position.Right} id="r" isConnectable={false} style={HIDDEN_HANDLE} />
    </motion.div>
  )
}
function ResourceFlowNode({ data }: NodeProps) {
  const d = data as unknown as ResourceData
  const emRef = useRef<HTMLDivElement>(null)
  const armed = useApproachArm(emRef, !!d.r.em)
  /* student lens: paint this card with the selected student's journey state.
     A map with no entry for this card = no mastery signal ("not yet covered",
     the old canvas rule) → dimmed. null context = lens off, untouched. */
  const overlay = useContext(JourneyOverlayContext)
  const jo = overlay ? (d.r.key ? overlay[d.r.key] ?? null : null) : undefined
  const joCls = overlay ? (jo ? ` jo-${JOURNEY_CLASS[jo.state]}` : ' jo-nc') : ''
  /* The two UNLABELLED lens states get a hover title — they draw the same
     dashed ring + dim and differ only in meaning, and with the legend parked
     nothing else names them. "Not started" without this reads as a judgement
     on a node the class may simply not have reached. The three scored states
     carry their own numeric chip (.jopct) and need no title. */
  const joTitle = !overlay ? undefined
    : jo
      ? (jo.state === 'not_started' ? 'Not started — this student has no signal here yet' : undefined)
      : 'Not yet covered — nothing to judge by here'
  /* Its quick check is being written right now (the student opened it and the
     pool job hasn't landed). The card shimmers — the same sweep the open card's
     "looking for a quick check…" line uses, so one animation means one thing in
     both places — and says so on hover, since a sweep alone is just movement.
     Not on the emphasis channel: see `Resource.baking`. */
  const baking = d.r.baking ? ' baking' : ''
  return (
    <motion.div ref={emRef} title={joTitle ?? (d.r.baking ? 'Writing a few questions on this…' : undefined)} className={`rf-node side-${d.side} jit-${d.jit}${emphasisClass(d.r.em, armed)}${joCls}${baking}`} style={emphasisStyle(d.r.em, d.r.emTone)} {...rise(d.delay)}>
      <Res r={d.r} calm={d.calm} />
      {jo && jo.pct != null ? (
        <span className="jopct" style={cssVars({ '--jc': JOURNEY_COLOR[jo.state] })}><i />{jo.pct}%</span>
      ) : null}
      {/* The words for this live in the annotation layer (a margin note with an
          arrow into the card), not on the card: a chip pinned to the node sat
          under the card's own hover lift, and the map already has one hand for
          telling you things. The announcement is one persistent region at canvas
          level (`bakingTitles`) — a live region mounted here WITH its text already
          in it announces nothing on most screen readers, and said "on this" with
          no node named. */}
      {d.side === 'L'
        ? <Handle type="target" position={Position.Right} id="r" isConnectable={false} style={HIDDEN_HANDLE} />
        : <Handle type="target" position={Position.Left} id="l" isConnectable={false} style={HIDDEN_HANDLE} />}
    </motion.div>
  )
}
function NoteFlowNode({ data }: NodeProps) {
  const d = data as unknown as NoteData
  const emRef = useRef<HTMLDivElement>(null)
  const armed = useApproachArm(emRef, !!d.note.em)
  return <motion.div ref={emRef} className={`rf-node${emphasisClass(d.note.em, armed)}`} style={emphasisStyle(d.note.em, d.note.emTone)} {...notePop(d.delay)}><NoteCard note={d.note} calm={d.calm} i={d.i} author={d.author} /></motion.div>
}
function SessionFlowNode({ data }: NodeProps) {
  const d = data as unknown as SessionData
  const emRef = useRef<HTMLDivElement>(null)
  const armed = useApproachArm(emRef, !!d.s.em)
  /* sessions carry no per-student mastery signal → dim under the student lens */
  const nc = useContext(JourneyOverlayContext) ? ' jo-nc' : ''
  return <motion.div ref={emRef} title={nc ? 'Not yet covered — nothing to judge by here' : undefined} className={`rf-node${emphasisClass(d.s.em, armed)}${nc}`} style={emphasisStyle(d.s.em, d.s.emTone)} {...rise()}><SessionCard s={d.s} /></motion.div>
}
function LiveFlowNode({ data }: NodeProps) {
  const d = data as unknown as LiveData
  const emRef = useRef<HTMLDivElement>(null)
  const armed = useApproachArm(emRef, !!d.room?.em)
  const nc = useContext(JourneyOverlayContext) ? ' jo-nc' : ''
  return <motion.div ref={emRef} title={nc ? 'Not yet covered — nothing to judge by here' : undefined} className={`rf-node${emphasisClass(d.room?.em, armed)}${nc}`} style={emphasisStyle(d.room?.em, d.room?.emTone)} {...rise()}><LiveCard room={d.room} /></motion.div>
}
/* The static face of one Athena note: the widget itself, at rest. Purely a
   PREVIEW — pointer-events are off (CSS), the whole card opens the modal and
   every interaction lives there — so it renders the artifact's current state
   (first card / first question / ticked steps) and nothing more. aria-hidden:
   the card's title + summary line already say everything this repeats. */
function AthenaPreview({ a }: { a: AthenaArtifactView }) {
  switch (a.kind) {
    case 'flashcards': {
      const cards = (a.payload as FlashcardsPayload).cards ?? []
      if (cards.length === 0) return null
      return (
        <div className="athx-prev" aria-hidden>
          <div className="athx-fcard">{cards[0].front}</div>
          {/* counter only — pager chevrons here looked like live controls
              and taught the reader that the card's controls are fake */}
          <div className="athx-fnav"><span className="athx-fcnt">1 / {cards.length}</span></div>
        </div>
      )
    }
    case 'practice': {
      const qs = (a.payload as PracticePayload).questions ?? []
      if (qs.length === 0) return null
      const q = qs[0]
      const chosen = a.state.answers?.['0']
      const locked = chosen !== undefined
      return (
        <div className="athx-prev" aria-hidden>
          <div className="athx-q">{q.prompt}</div>
          {q.options.map((o, oi) => (
            /* verdict = glyph + colour, never colour alone — same contract as
               the modal widget's .aw-tag */
            <div key={oi} className={`athx-opt${locked && o.correct ? ' ok' : locked && oi === chosen ? ' bad' : ''}`}>
              <span className="athx-opt-t">{o.text}</span>
              {locked && o.correct ? <span className="athx-tag ok">✓</span> : null}
              {locked && oi === chosen && !o.correct ? <span className="athx-tag bad">✗</span> : null}
            </div>
          ))}
        </div>
      )
    }
    case 'checklist': {
      const steps = (a.payload as ChecklistPayload).steps ?? []
      if (steps.length === 0) return null
      const done = new Set(a.state.done ?? [])
      const doneCount = steps.filter((_, i) => done.has(i)).length
      /* Window the four visible steps around the first UNDONE one (with one
         ticked step of context), so the preview shows where the student
         actually is — not a half-full bar over four untouched rows. */
      const firstUndone = steps.findIndex((_, i) => !done.has(i))
      const start = firstUndone < 0
        ? Math.max(0, steps.length - 4)
        : Math.min(Math.max(0, firstUndone - 1), Math.max(0, steps.length - 4))
      const shown = steps.slice(start, start + 4)
      return (
        <div className="athx-prev" aria-hidden>
          {start > 0 ? <div className="athx-more">✓ {start} earlier done</div> : null}
          {shown.map((s, j) => {
            const i = start + j
            return (
              <div key={i} className={`athx-step${done.has(i) ? ' done' : ''}`}>
                <span className="athx-cb">{done.has(i) ? '✓' : ''}</span>
                <span className="athx-step-t">{s.label}</span>
                {s.minutes ? <span className="athx-mins">{s.minutes} min</span> : null}
              </div>
            )
          })}
          {start + shown.length < steps.length ? <div className="athx-more">+{steps.length - start - shown.length} more steps</div> : null}
          <div className="athx-bar"><i style={{ width: `${(100 * doneCount) / steps.length}%` }} /></div>
        </div>
      )
    }
    case 'knowledge_map': {
      const km = a.payload as KnowledgeMapPayload
      const stops = km.stops ?? []
      if (stops.length === 0) return null
      return (
        <div className="athx-prev" aria-hidden>
          {stops.slice(0, 3).map((s, i) => (
            <div key={i} className="athx-kstop">
              <span className="athx-kn">{i + 1}</span>
              <span className="athx-kt">{s.title}</span>
              {s.masteryPct != null ? <span className="athx-km">{s.masteryPct}%</span> : null}
            </div>
          ))}
          {stops.length > 3 ? <div className="athx-more">+{stops.length - 3} more stops</div> : null}
          <div className="athx-kfocus">→ {km.focus?.title}</div>
        </div>
      )
    }
    case 'study_guide': {
      const sections = (a.payload as StudyGuidePayload).sections ?? []
      if (sections.length === 0) return null
      const first = sections[0]
      return (
        <div className="athx-prev" aria-hidden>
          <div className="athx-gh">{first.heading}</div>
          {(first.points ?? []).slice(0, 3).map((p, i) => (
            <div key={i} className="athx-gpt"><span className="athx-gb">•</span>{p.text}</div>
          ))}
          {sections.length > 1 ? (
            <div className="athx-more">+{sections.length - 1} more section{sections.length - 1 === 1 ? '' : 's'}</div>
          ) : null}
        </div>
      )
    }
  }
}
/* Athena's margin note — student-only lane on the right edge. Deliberately a
   NOTE, not a resource card: violet-washed paper, dashed edge, serif italic
   title (the marginalia voice), so it never reads as course material the
   professor placed. The widget shows as a static preview on the card;
   clicking anywhere opens the same node-detail modal as everything else,
   which is where the interaction lives. */
function AthenaFlowNode({ data }: NodeProps) {
  const d = data as unknown as AthenaData
  const meta = ARTIFACT_KIND_META[d.a.kind]
  return (
    <motion.div className="rf-node" {...notePop(d.j * 0.07)}>
      {/* role/tabIndex/keydown: an artifact exists NOWHERE else in the app, so
          unlike every other node kind this card is its only door — the synthetic
          click bubbles to the wrapper and takes React Flow's onNodeClick path. */}
      <div
        className="athx"
        role="button"
        tabIndex={0}
        aria-label={`${meta.label} from Athena: ${d.a.title} — ${meta.summary(d.a.payload, d.a.state)}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click() }
        }}
      >
        <div className="athx-k">✦ {meta.label} · from Athena</div>
        <div className="athx-t" title={d.a.title}>{d.a.title}</div>
        <AthenaPreview a={d.a} />
        <div className="athx-s">{meta.summary(d.a.payload, d.a.state)}</div>
      </div>
      <Handle type="target" position={Position.Left} id="l" isConnectable={false} style={HIDDEN_HANDLE} />
    </motion.div>
  )
}
/* ── The knowledge-path ink (issue #94) — Athena's hand on the map ─────────
   Rendered inside the ViewportPortal so it pans and zooms with the paper.
   Pure presentation: stops arrive already resolved to on-map boxes (the
   parent dropped anything not currently rendered), ordered foundational →
   focus. This layer draws the option-C annotations — hand rings, numbered
   stops, the "start here" margin note — plus the connecting wires; the GLOW
   rides the node className (`kp-lit`), and the dim rides the root class
   (`kp-on`), so each half can be reasoned about alone. Pointer-inert like
   the annotation layer: the map stays clickable through it. */
interface KpBox { x: number; y: number; w: number; h: number }

/** Ports sit OUTSIDE the ink ring (rx = w/2 + 26), not inside it. */
const KP_CLEAR = 30
/** Corridor lane spacing when two legs share a channel (the nudging pass). */
const KP_RAIL_LANE = 18
/** Corner rounding for corridor waypoints before smoothing. */
const KP_CHAMFER = 26

/** X where the stop's ink ring passes at height `dy` off the card's centre —
 *  wires start and end ON the drawn loop, not dangling beside it (the ring is
 *  an ellipse, so at slot height its boundary is well inside edge + pad). */
function kpPortX(b: KpBox, side: 'L' | 'R', dy: number): number {
  const rx = b.w / 2 + 26, ry = b.h / 2 + 16
  const r = rx * Math.sqrt(Math.max(0.2, 1 - (dy / ry) ** 2)) - 2
  return b.x + b.w / 2 + (side === 'R' ? r : -r)
}

/** Leave from the face of `a` pointing at `b`, arrive on the facing edge of
 *  `b` — ring to ring. Direct legs only; anything that must pass other cards
 *  is routed by the channel router below. */
function kpAnchor(a: KpBox, b: KpBox): { sx: number; sy: number; ex: number; ey: number } {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2
  if (Math.abs(bcx - acx) > Math.abs(bcy - acy)) {
    const sx = kpPortX(a, bcx > acx ? 'R' : 'L', 0)
    const ex = kpPortX(b, bcx > acx ? 'L' : 'R', 0)
    return { sx, sy: acy, ex, ey: bcy }
  }
  /* vertical: the ring's top/bottom sits at ±(h/2 + 16); land 2px inside */
  const sy = bcy > acy ? a.y + a.h + 14 : a.y - 14
  const ey = bcy > acy ? b.y - 14 : b.y + b.h + 14
  return { sx: acx, sy, ex: bcx, ey }
}

/** A bowed cubic — the pen never travels straight — plus the two-stroke
 *  chevron at the arrival end, the same head geometry the annotation layer's
 *  arrows use. */
function kpWire(w: { sx: number; sy: number; ex: number; ey: number }): { curve: string; head: string } {
  const dx = w.ex - w.sx, dy = w.ey - w.sy
  const len = Math.hypot(dx, dy) || 1
  const bow = Math.min(80, Math.max(30, len * 0.16))
  const nx = (-dy / len) * bow, ny = (dx / len) * bow
  const c1x = w.sx + dx * 0.3 + nx, c1y = w.sy + dy * 0.3 + ny
  const c2x = w.sx + dx * 0.72 + nx * 0.6, c2y = w.sy + dy * 0.72 + ny * 0.6
  const th = Math.atan2(w.ey - c2y, w.ex - c2x)
  const leg = 11
  const h1x = w.ex + leg * Math.cos(th + 2.65), h1y = w.ey + leg * Math.sin(th + 2.65)
  const h2x = w.ex + leg * Math.cos(th - 2.65), h2y = w.ey + leg * Math.sin(th - 2.65)
  return {
    curve: `M ${w.sx} ${w.sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${w.ex} ${w.ey}`,
    head: `M ${w.ex} ${w.ey} L ${h1x} ${h1y} M ${w.ex} ${w.ey} L ${h2x} ${h2y}`,
  }
}

/* Reveal cadence: fast enough that the whole path lands inside ~a second even
   at the 8-stop payload cap — the state lives in the URL, so this replays on
   every refresh and re-open, and a slow reveal is charming exactly once. */
const KP_STEP = 0.12
const KP_TAIL_MAX = 0.9

/* Tiny seeded PRNG (mulberry32) — the loop must not change shape on re-render,
   and Math.random would redraw every stop's circle on every layout tick. */
function kpRand(seed: number): () => number {
  let t = (seed * 0x9e3779b9) >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), t | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/* An ORGANIC circling stroke — the knowledge map's own, deliberately looser
   than the annotation layer's squircle (`roughLoop`, which stays as-is for
   every other pen ring): a tilted ellipse walked with per-point radius wobble,
   overshooting a full turn by 30–60° with the tail drifting slightly outward,
   the way a hand actually circles something. Catmull-Rom smoothed. */
function kpLoop(cx: number, cy: number, rx: number, ry: number, seed: number): string {
  const rnd = kpRand(seed)
  const rot = (rnd() - 0.5) * 0.24
  const start = rnd() * Math.PI * 2
  const total = Math.PI * 2 + 0.5 + rnd() * 0.55
  const steps = 10
  const pts: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = start + (total * i) / steps
    const overshoot = Math.max(0, a - start - Math.PI * 2)
    const wob = 1 + (rnd() - 0.5) * 0.14
    const r1 = rx * wob * (1 + overshoot * 0.05)
    const r2 = ry * (1 + (rnd() - 0.5) * 0.14) * (1 + overshoot * 0.05)
    const ex = Math.cos(a) * r1, ey = Math.sin(a) * r2
    pts.push([
      cx + ex * Math.cos(rot) - ey * Math.sin(rot),
      cy + ex * Math.sin(rot) + ey * Math.cos(rot),
    ])
  }
  return smoothPath(pts)
}

/** Catmull-Rom → cubic through every point — shared by the pen loop and the
 *  routed wires, so the whole layer is one hand. */
function smoothPath(pts: [number, number][]): string {
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }
  return d
}

/* ── The channel router — how a leg gets AROUND cards instead of across them.
   Channel routing with slotted ports (the yFiles/libavoid shape, sized to our
   canvas): the layout is columns with free gutters between and margins
   outside, so every non-direct leg is "out to a corridor, along it, back in".
   Each leg scores 1 direct candidate + (corridor × side) candidates and takes
   the cheapest; penalties on corridor REUSE and on a node side already at
   capacity are what break up the one-rail edge junction — the second leg out
   of a node prefers a different corridor, and a different corridor implies a
   different side. Deterministic, pure, ~5k ops for the 8-leg worst case. */

interface KpRouted {
  i: number
  kind: 'direct' | 'routed'
  /** direct: the bowed-cubic anchors. */
  a?: { sx: number; sy: number; ex: number; ey: number }
  /** routed: waypoint polyline port → corridor → port. */
  pts?: [number, number][]
  corridor?: number
  span?: [number, number]
}

const kpBlocksH = (o: KpBox, y: number, x0: number, x1: number, m = 6) =>
  y > o.y - m && y < o.y + o.h + m && Math.max(x0, x1) > o.x - m && Math.min(x0, x1) < o.x + o.w + m
const kpBlocksV = (o: KpBox, x: number, y0: number, y1: number, m = 6) =>
  x > o.x - m && x < o.x + o.w + m && Math.max(y0, y1) > o.y - m && Math.min(y0, y1) < o.y + o.h + m
const kpInRect = (o: KpBox, x: number, y: number, m = 6) =>
  x > o.x - m && x < o.x + o.w + m && y > o.y - m && y < o.y + o.h + m
const kpSameBox = (a: KpBox, b: KpBox) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1

/** Free vertical channels: one in every gap between merged x-bands of the
 *  rendered cards, plus one margin outside each end. Derived, not hardcoded,
 *  so it survives layout changes and mirrors for the left column for free. */
function kpCorridors(obstacles: KpBox[]): number[] {
  if (obstacles.length === 0) return []
  const iv = obstacles.map((o) => [o.x, o.x + o.w] as [number, number]).sort((p, q) => p[0] - q[0])
  const bands: [number, number][] = [iv[0]]
  for (const [x0, x1] of iv.slice(1)) {
    const last = bands[bands.length - 1]
    if (x0 <= last[1] + 8) last[1] = Math.max(last[1], x1)
    else bands.push([x0, x1])
  }
  const out = [bands[0][0] - 110]
  for (let k = 0; k < bands.length - 1; k++) out.push((bands[k][1] + bands[k + 1][0]) / 2)
  out.push(bands[bands.length - 1][1] + 110)
  return out
}

/** Sample the direct bow and reject it if it lands on any card that isn't an
 *  endpoint — the reason stateless direction-only anchors pile up on rails. */
function kpDirectClear(a: KpBox, b: KpBox, obstacles: KpBox[]): boolean {
  const w = kpAnchor(a, b)
  const dx = w.ex - w.sx, dy = w.ey - w.sy
  const len = Math.hypot(dx, dy) || 1
  const bow = Math.min(80, Math.max(30, len * 0.16))
  const nx = (-dy / len) * bow, ny = (dx / len) * bow
  const c1x = w.sx + dx * 0.3 + nx, c1y = w.sy + dy * 0.3 + ny
  const c2x = w.sx + dx * 0.72 + nx * 0.6, c2y = w.sy + dy * 0.72 + ny * 0.6
  for (const t of [0.15, 0.3, 0.5, 0.7, 0.85]) {
    const u = 1 - t
    const px = u * u * u * w.sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * w.ex
    const py = u * u * u * w.sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * w.ey
    for (const o of obstacles) {
      if (kpSameBox(o, a) || kpSameBox(o, b)) continue
      if (kpInRect(o, px, py)) return false
    }
  }
  return true
}

function routeKnowledgeWires(chain: KpBox[], obstacles: KpBox[]): KpRouted[] {
  const corridors = kpCorridors(obstacles)
  const taken = new Map<number, Set<string>>() /* chain idx → claimed side:slot */
  const used: { cx: number; y0: number; y1: number }[] = []
  const claim = (idx: number, key: string) => {
    const set = taken.get(idx) ?? new Set<string>()
    set.add(key)
    taken.set(idx, set)
  }
  const clearBetween = (a: KpBox, b: KpBox) =>
    obstacles.filter((o) => !kpSameBox(o, a) && !kpSameBox(o, b))

  const out: KpRouted[] = []
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i], b = chain[i + 1]
    const acy = a.y + a.h / 2, bcy = b.y + b.h / 2
    const down = bcy > acy
    const slotA = down ? 'lo' : 'hi' /* leave from the half facing travel */
    const slotB = down ? 'hi' : 'lo' /* arrive on the half facing the wire */
    const sA = Math.min(a.h / 4, 34), sB = Math.min(b.h / 4, 34)
    const others = clearBetween(a, b)

    /* abutting same-column neighbours: gap too small for real ports — a short
       C tucked against the lane (the case that used to draw backwards) */
    if (Math.abs(a.x - b.x) < 8 && Math.abs(down ? b.y - (a.y + a.h) : a.y - (b.y + b.h)) < 2 * KP_CLEAR) {
      const takenA = taken.get(i) ?? new Set()
      const takenB = taken.get(i + 1) ?? new Set()
      const side = takenA.has(`R:${slotA}`) || takenB.has(`R:${slotB}`) ? 'L' : 'R'
      const dyA = down ? sA : -sA, dyB = down ? -sB : sB
      const pax = kpPortX(a, side, dyA), pbx = kpPortX(b, side, dyB)
      const bulge = side === 'R' ? Math.max(pax, pbx) + 30 : Math.min(pax, pbx) - 30
      claim(i, `${side}:${slotA}`); claim(i + 1, `${side}:${slotB}`)
      out.push({ i, kind: 'routed', pts: [[pax, acy + dyA], [bulge, (acy + dyA + bcy + dyB) / 2], [pbx, bcy + dyB]] })
      continue
    }

    type Cand = { cost: number; routed?: Omit<KpRouted, 'i' | 'kind'>; keys?: [string, string] }
    const cands: Cand[] = []
    if (kpDirectClear(a, b, obstacles)) {
      cands.push({ cost: Math.hypot(bcy - acy, b.x - a.x) - 250 })
    }
    for (const cx of corridors) {
      const sideA = cx > a.x + a.w / 2 ? 'R' : 'L'
      const sideB = cx > b.x + b.w / 2 ? 'R' : 'L'
      const tryCand = (slA: string, slB: string, slotPenalty: number) => {
        const dyA = slA === 'lo' ? sA : -sA, dyB = slB === 'lo' ? sB : -sB
        const say = acy + dyA, sby = bcy + dyB
        const sax = kpPortX(a, sideA, dyA)
        const sbx = kpPortX(b, sideB, dyB)
        if (others.some((o) => kpBlocksH(o, say, sax, cx))) return
        if (others.some((o) => kpBlocksH(o, sby, sbx, cx))) return
        if (obstacles.some((o) => kpBlocksV(o, cx, say, sby))) return
        const capA = (taken.get(i) ?? new Set()).has(`${sideA}:${slA}`) ? 400 : 0
        const capB = (taken.get(i + 1) ?? new Set()).has(`${sideB}:${slB}`) ? 400 : 0
        const y0 = Math.min(say, sby), y1 = Math.max(say, sby)
        const overlap = used.some((u) => u.cx === cx && u.y0 < y1 && u.y1 > y0) ? 150 : 0
        const reuse = used.some((u) => u.cx === cx) ? 60 : 0
        cands.push({
          cost: Math.abs(cx - sax) + Math.abs(cx - sbx) + Math.abs(say - sby) + slotPenalty + capA + capB + overlap + reuse,
          routed: { pts: [[sax, say], [cx, say], [cx, sby], [sbx, sby]], corridor: cx, span: [y0, y1] },
          keys: [`${sideA}:${slA}`, `${sideB}:${slB}`],
        })
      }
      tryCand(slotA, slotB, 0)
      tryCand(slotA === 'lo' ? 'hi' : 'lo', slotB, 120)
      tryCand(slotA, slotB === 'lo' ? 'hi' : 'lo', 120)
    }
    if (cands.length === 0) {
      out.push({ i, kind: 'direct', a: kpAnchor(a, b) }) /* never emit nothing */
      continue
    }
    cands.sort((p, q) => p.cost - q.cost)
    const best = cands[0]
    if (!best.routed) {
      out.push({ i, kind: 'direct', a: kpAnchor(a, b) })
      continue
    }
    claim(i, best.keys![0]); claim(i + 1, best.keys![1])
    used.push({ cx: best.routed.corridor as number, y0: best.routed.span![0], y1: best.routed.span![1] })
    out.push({ i, kind: 'routed', ...best.routed })
  }

  /* nudge: legs sharing a corridor spread symmetrically about its centre,
     longest span outermost, so nested runs never cross */
  const byCorridor = new Map<number, KpRouted[]>()
  for (const r of out) {
    if (r.kind === 'routed' && r.corridor !== undefined) {
      byCorridor.set(r.corridor, [...(byCorridor.get(r.corridor) ?? []), r])
    }
  }
  for (const [cx, legs] of byCorridor) {
    if (legs.length < 2) continue
    legs.sort((p, q) => (q.span![1] - q.span![0]) - (p.span![1] - p.span![0]))
    legs.forEach((r, k) => {
      const nx = cx + (k - (legs.length - 1) / 2) * KP_RAIL_LANE
      r.pts = r.pts!.map(([x, y]) => (Math.abs(x - cx) < 0.5 ? [nx, y] : [x, y]) as [number, number])
    })
  }
  return out
}

/** De-kink, round, make it WANDER, then Catmull-Rom — so a routed leg reads
 *  as one pen stroke, not a plotted polyline.
 *
 *  De-kink: when a port sits almost ON its corridor (a gutter runs right
 *  beside the column, so the horizontal stub can be ~9px), the right-angle
 *  corner one chamfer can't round makes Catmull-Rom whip into a pointy
 *  hairpin — the corner is pulled 44px along the corridor instead, so the
 *  stroke leaves the ring and banks straight into the channel.
 *  Wander: long corridor runs are subdivided every ~150px with alternating
 *  seeded lateral drift — a hand never draws 500px dead straight. */
function kpRoutedPath(pts: [number, number][], seed: number): { curve: string; head: string } {
  const rnd = kpRand(seed)
  const p = pts.map(([x, y]) => [x, y] as [number, number])
  if (p.length === 4) {
    const travel = Math.sign(p[2][1] - p[1][1]) || 1
    if (Math.abs(p[0][0] - p[1][0]) < 46 && Math.abs(p[2][1] - p[1][1]) > 130) p[1][1] += travel * 44
    if (Math.abs(p[3][0] - p[2][0]) < 46 && Math.abs(p[2][1] - p[1][1]) > 130) p[2][1] -= travel * 44
  }
  const rounded: [number, number][] = [p[0]]
  for (let i = 1; i < p.length - 1; i++) {
    const [px, py] = p[i]
    const [ax, ay] = p[i - 1], [bx, by] = p[i + 1]
    const din = Math.hypot(px - ax, py - ay) || 1
    const dout = Math.hypot(bx - px, by - py) || 1
    /* a corner whose stub is too short to chamfer keeps its single point —
       two near-coincident chamfer points are exactly what kinked the curve */
    if (din < 34 || dout < 34) { rounded.push([px, py]); continue }
    const rin = Math.min(KP_CHAMFER, din / 2), rout = Math.min(KP_CHAMFER, dout / 2)
    rounded.push(
      [px - ((px - ax) / din) * rin, py - ((py - ay) / din) * rin],
      [px + ((bx - px) / dout) * rout, py + ((by - py) / dout) * rout],
    )
  }
  rounded.push(p[p.length - 1])
  /* subdivide long straights with drift, so the pen wanders */
  const wavy: [number, number][] = [rounded[0]]
  for (let i = 1; i < rounded.length; i++) {
    const [ax, ay] = rounded[i - 1], [bx, by] = rounded[i]
    const d = Math.hypot(bx - ax, by - ay)
    const n = Math.floor(d / 150)
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1)
      const off = (k % 2 ? 1 : -1) * (7 + rnd() * 9)
      const nxv = -(by - ay) / d, nyv = (bx - ax) / d
      wavy.push([ax + (bx - ax) * t + nxv * off, ay + (by - ay) * t + nyv * off])
    }
    wavy.push([bx, by])
  }
  const jittered = wavy.map(([x, y], k) =>
    (k === 0 || k === wavy.length - 1 ? [x, y] : [x + (rnd() - 0.5) * 6, y + (rnd() - 0.5) * 6]) as [number, number])
  const [ex, ey] = jittered[jittered.length - 1]
  const [qx, qy] = jittered[jittered.length - 2]
  const th = Math.atan2(ey - qy, ex - qx)
  const leg = 11
  return {
    curve: smoothPath(jittered),
    head: `M ${ex} ${ey} L ${ex + leg * Math.cos(th + 2.65)} ${ey + leg * Math.sin(th + 2.65)} M ${ex} ${ey} L ${ex + leg * Math.cos(th - 2.65)} ${ey + leg * Math.sin(th - 2.65)}`,
  }
}

function KnowledgePathInk({ stops, focus, weakestN, obstacles }: {
  stops: { title: string; masteryPct?: number | null; n: number; box: KpBox }[]
  focus: { title: string; box: KpBox } | null
  /** Payload number of the stop that carries the "start here" note (chosen in
   *  the kpath memo so the camera framing and this layer agree). */
  weakestN: number | null
  /** Every rendered card's box — what the channel router routes around. */
  obstacles: KpBox[]
}) {
  const chain: KpBox[] = [...stops.map((s) => s.box), ...(focus ? [focus.box] : [])]
  const routed = routeKnowledgeWires(chain, obstacles)
  const wires = routed.map((r) =>
    r.kind === 'direct'
      ? { i: r.i, ...kpWire(r.a as { sx: number; sy: number; ex: number; ey: number }) }
      : { i: r.i, ...kpRoutedPath(r.pts as [number, number][], r.i * 31 + 5) })
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of routed) {
    for (const [x, y] of r.pts ?? []) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    if (r.a) {
      minX = Math.min(minX, r.a.sx, r.a.ex); maxX = Math.max(maxX, r.a.sx, r.a.ex)
      minY = Math.min(minY, r.a.sy, r.a.ey); maxY = Math.max(maxY, r.a.sy, r.a.ey)
    }
  }
  const PAD = 120
  /* Consecutive materials in one column sit exactly COL_GAP apart, so the
     default ring inset would cross the neighbouring stop's ring; abutting
     stops get a tighter ring and their number on the outer edge instead. */
  const tightAbove = (b: KpBox) =>
    chain.some((o) => o !== b && Math.abs(o.x - b.x) < 8 && b.y > o.y && b.y - (o.y + o.h) <= COL_GAP + 6)
  const weakest = stops.find((s) => s.n === weakestN) ?? null
  const noteRight = weakest ? weakest.box.x >= RIGHT_X : false
  const tailDelay = Math.min(0.2 + stops.length * KP_STEP, KP_TAIL_MAX - 0.1)
  return (
    <div className="kp-ink" aria-hidden>
      {wires.length > 0 && (
        <svg
          className="kp-wire"
          style={{ position: 'absolute', left: minX - PAD, top: minY - PAD, width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2 }}
          viewBox={`${minX - PAD} ${minY - PAD} ${maxX - minX + PAD * 2} ${maxY - minY + PAD * 2}`}
        >
          {wires.map((w) => (
            <g key={w.i} style={cssVars({ '--kp-d': `${0.2 + w.i * KP_STEP}s` })}>
              <path className="w" d={w.curve} />
              <path className="hd" d={w.head} />
            </g>
          ))}
        </svg>
      )}
      {stops.map((s, i) => {
        const tight = tightAbove(s.box)
        const cx = s.box.x + s.box.w / 2, cy = s.box.y + s.box.h / 2
        /* the annotation layer's own squircle pads (±jitter clearance), pulled
           in vertically when the neighbouring stop sits one COL_GAP away */
        const rx = s.box.w / 2 + 26, ry = s.box.h / 2 + (tight ? 6 : 16)
        const bx = cx - rx - 14, by = cy - ry - 14, bw = rx * 2 + 28, bh = ry * 2 + 28
        return (
          <div key={i} style={cssVars({ '--kp-d': `${0.1 + i * KP_STEP}s`, '--t': 'var(--c-athena)' })}>
            {/* the circling pen, in the knowledge map's own looser hand
                (kpLoop) — organic tilt/wobble/overshoot, badge-purple ink */}
            <svg className="an an-ring kp-loop" style={{ position: 'absolute', left: bx, top: by, width: bw, height: bh }} viewBox={`${bx} ${by} ${bw} ${bh}`}>
              <path className="p1" d={kpLoop(cx, cy, rx, ry, i * 13 + 3)} />
              <path className="p2" d={kpLoop(cx, cy, rx - 2, ry - 2, i * 13 + 10)} />
            </svg>
            <div className="kp-num" style={tight ? { left: s.box.x + s.box.w - 15, top: s.box.y - 9 } : { left: s.box.x - 15, top: s.box.y - 15 }}>{s.n}</div>
          </div>
        )
      })}
      {focus && (() => {
        const cx = focus.box.x + focus.box.w / 2, cy = focus.box.y + focus.box.h / 2
        const rx = focus.box.w / 2 + 28, ry = focus.box.h / 2 + 18
        const bx = cx - rx - 14, by = cy - ry - 14, bw = rx * 2 + 28, bh = ry * 2 + 28
        return (
          <div style={cssVars({ '--kp-d': `${tailDelay}s`, '--t': 'var(--c-athena)' })}>
            <svg className="an an-ring kp-loop kp-loop-focus" style={{ position: 'absolute', left: bx, top: by, width: bw, height: bh }} viewBox={`${bx} ${by} ${bw} ${bh}`}>
              <path className="p1" d={kpLoop(cx, cy, rx, ry, 97)} />
              <path className="p2" d={kpLoop(cx, cy, rx - 2, ry - 2, 104)} />
            </svg>
            <div className="kp-tag" style={{ left: focus.box.x + focus.box.w - 148, top: focus.box.y - 32 }}>what you asked about</div>
          </div>
        )
      })()}
      {weakest && (
        /* Mirrored to the stop's outer side: a left-anchored note on a
           right-column stop lands on the module band and reads as the wrong
           card's (the freeSlot() lesson in roadmap-annotations.tsx). */
        <div
          className={`kp-note${noteRight ? ' kp-note-r' : ''}`}
          style={{
            ...cssVars({ '--kp-d': `${Math.min(tailDelay + 0.15, KP_TAIL_MAX)}s` }),
            left: noteRight ? weakest.box.x + weakest.box.w + 54 : weakest.box.x - 252,
            top: weakest.box.y + 4,
          }}
        >
          start here — {weakest.masteryPct != null ? 'your weakest link' : 'the path begins'}
          <svg viewBox="0 0 46 30" width="46" height="30" style={noteRight ? { transform: 'scaleX(-1)' } : undefined}>
            <path d="M4 26 C 20 26, 34 18, 40 6" />
            <path d="M40 6 l-8.6 1.6 M40 6 l0.8 8.6" />
          </svg>
        </div>
      )}
    </div>
  )
}

function SpineFlowNode({ data }: NodeProps) {
  const d = data as unknown as SpineData
  return (
    <div className="rf-spine" style={{ height: d.height }}>
      {d.segments.map((s, i) => (
        <div key={i} className={`seg ${s.phase}`} style={{ height: s.height }} />
      ))}
    </div>
  )
}
/* module → spine colour: green only at 100%, grey when untouched, blue between.
   Real data sets `phase`; the demo course falls back to its pct. */
const phaseOf = (m: CourseModule): SpinePhase =>
  /* A week that isn't open yet is grey by definition — the spine must not claim
     progress through material the class hasn't reached. */
  m.locked ? 'todo' : m.phase ?? (m.pct >= 100 ? 'done' : m.pct <= 0 ? 'todo' : 'prog')

/* Divider — the professor's own break in the sequence, drawn as the annotation
   layer's `rule`: the same jittered pen line (rulePath) under the same italic
   label knocked out of it, reusing .an-rule / .an-rule-label so it IS that
   annotation, not a lookalike. Unlike an annotation it is a real node: it must
   survive the student lens and the focused/everything toggle, and it sits
   BETWEEN two specific cards. */
function DividerFlowNode({ data }: NodeProps) {
  const d = data as unknown as DividerData
  const tone = cssVars({ '--t': AN_TONE.slate })
  return (
    <div className="rf-divider" style={{ height: DIV_H }}>
      <svg className="an-rule" viewBox={`0 0 ${d.w} ${DIV_H}`} style={tone}>
        <path d={rulePath(d.w, DIV_H, d.title)} />
      </svg>
      <span className="an-rule-label" style={tone}>{d.title}</span>
    </div>
  )
}

/* TODAY — the professor-divider's pen line (the §14 `rule` annotation) in the
   alert tone, labelled with the date. It says where the term is right now; the
   unplaced work waiting nearby is scattered AROUND it, not tied to it. */
function TodayLineFlowNode({ data }: NodeProps) {
  const d = data as unknown as TodayData
  const tone = cssVars({ '--t': AN_TONE.alert })
  return (
    <div className="rf-divider rf-today" style={{ height: DIV_H }}>
      <svg className="an-rule" viewBox={`0 0 ${d.w} ${DIV_H}`} style={tone}>
        <path d={rulePath(d.w, DIV_H, d.label)} />
      </svg>
      <span className="an-rule-label" style={tone}>{d.label}</span>
    </div>
  )
}

/* UNPLACED — a quiz/assignment with no week yet: the ordinary typed card, sat
   loose on the paper near the today-line. The only draggable node on the map;
   dragging it into a module's reach snaps it into that module's column, and the
   drop writes the placement. Styling: §22 in roadmap-prototype.css. */
function UnplacedFlowNode({ data }: NodeProps) {
  const d = data as unknown as UnplacedData
  return (
    <motion.div className={`rf-node up side-${d.side}`} {...rise()}>
      <Res r={d.r} calm={d.calm} />
      {d.side === 'L'
        ? <Handle type="target" position={Position.Right} id="r" isConnectable={false} style={HIDDEN_HANDLE} />
        : <Handle type="target" position={Position.Left} id="l" isConnectable={false} style={HIDDEN_HANDLE} />}
    </motion.div>
  )
}

/* DROP SLOT — the place a module's column holds open while a card is being
   dragged onto it: an empty outline exactly the incoming card's size, at the
   foot of the lane it will join. The cards below the band shift down for it, so
   the week visibly makes room rather than just lighting up. */
function DropSlotFlowNode({ data }: NodeProps) {
  const d = data as unknown as DropSlotData
  return <div className="rf-drop" style={{ height: d.h }} aria-hidden />
}

const nodeTypes: NodeTypes = {
  module: ModuleFlowNode,
  resource: ResourceFlowNode,
  note: NoteFlowNode,
  session: SessionFlowNode,
  live: LiveFlowNode,
  spine: SpineFlowNode,
  divider: DividerFlowNode,
  todayline: TodayLineFlowNode,
  unplaced: UnplacedFlowNode,
  dropslot: DropSlotFlowNode,
  athena: AthenaFlowNode,
}

/* ════════════════════════════════════════════════════════════════
   E · LAYOUT — compute absolute x/y for every node + the edges.
       Vertical spine at x=0; resources fan LEFT (quizzes/assignments)
       and RIGHT (materials); notes sit on the spine below the card.
   ════════════════════════════════════════════════════════════════ */
const MOD_W = 340, RES_W = 300, LIVE_W = 320, SESS_W = 320, NOTE_W = 230
const MOD_X = -MOD_W / 2
const GAP_SPINE = 70
const LEFT_X = MOD_X - GAP_SPINE - RES_W
const RIGHT_X = MOD_W / 2 + GAP_SPINE
const LIVE_X = -LIVE_W / 2, SESS_X = -SESS_W / 2, NOTE_X = -NOTE_W / 2
/* gaps: kept small + constant. Node-to-node distance is exactly COL_GAP once
   real (measured) heights replace the estimates below. */
const COL_GAP = 12, MOD_GAP = 44, TOP_PAD = 24
/* A roof flag (the act-now banner: "3 didn't turn this in", "closes tonight") is
   planted in the air ABOVE its card, and COL_GAP alone leaves it nowhere to stand
   — every card in a lane sits 12px under the one before it. A lane therefore
   reserves the flag's own height above whichever card carries one, so the loudest
   annotation on the map lands on the roof it was designed for instead of being
   pushed into the margin. Only the flagged card pays for it. */
const FLAG_AIR = 52
const EMPTY_TITLES: ReadonlySet<string> = new Set()
/* dividers: the in-module one spans the materials lane; the module-level one
   spans the whole map (left column edge → right column edge, plus a margin). */
const DIV_H = 22
/* A module-level divider separates rather than labels, so it gets clearly more
   air than the ordinary band gap and the SAME amount on both sides — otherwise
   it reads as belonging to the module it sits nearer. MOD_GAP is already spent
   by the time it is placed, hence the two different numbers. */
const DIV_GAP = 72
const DIV_LEAD = DIV_GAP - MOD_GAP
const WIDE_PAD = 40
const WIDE_X = LEFT_X - WIDE_PAD
const WIDE_W = RIGHT_X + RES_W + WIDE_PAD - WIDE_X
const SKILL_OVERHANG = 14 /* the "n skills" pill hangs below the card box */
const EDGE_STYLE: CSSProperties = { stroke: 'oklch(0.78 0.02 255)', strokeWidth: 2, strokeDasharray: '5 6' }
/* ── unplaced nodes ──
   Work with no week yet waits loose around the today-line, straddling the spine
   so it reads as "near now, not filed". The scatter is INDEX-DERIVED, never
   random: a re-layout must not reshuffle the map. Two cards per row (one either
   side), each nudged off its lane and dropped a little, so the group looks set
   down by hand rather than stacked. */
const UNPLACED_DX = [30, -30, -12, 14]
const UNPLACED_DY = [0, 30, 14, 46]
const UNPLACED_LEAD = 34
/* How many loose cards the map will hold at once.
   Unbounded, this block is the largest thing on the roadmap. Measured on a real
   course (506 NLP, 139 unplaced items): 139 nodes spanning canvas y 3460→13192,
   about 9,700px of scatter inside a 13,300px map — 73% of the professor's
   roadmap, pushing the band after the today-line from y=3182 to y=13328. The row
   it replaced was at least bounded, and "drag it onto any week" is not an
   instruction you can act on 139 times.
   12 is six rows: enough that the block reads as a pile with work still in it,
   small enough that the term below stays on the same screen. The pile drains as
   cards are placed, so the tail is reachable without a second surface. */
const UNPLACED_ON_MAP_MAX = 12
/* Does the two-lane parking fit on screen?
   The loose block parks at LEFT_X (−540) and RIGHT_X (+240), so it needs ~540
   canvas px either side of the spine. fitZoom floors at 0.8, so on a narrow
   screen the visible canvas simply stops short of that and the whole block sits
   outside the frame: measured at 390px, 6 loose cards fell inside the vertical
   viewport and ZERO were horizontally visible — they parked at screen x −185…55
   (behind the 56px rail) and 391…631 (past the right edge), with the margin note
   at −305. The professor saw the today-line and then blank paper.
   The module bands are only 340 wide and centred, which is why they were fine and
   this was not: it is the lane parking that doesn't fit, not the canvas.
   Below the threshold the cards stack in ONE centred column instead. */
const looseStackedFor = (w: number) => w > 0 && w / fitZoom(w) / 2 < Math.abs(LEFT_X)
/** The edge previewing where a dragged card will land — solid accent, because
 *  by the time it shows, the week has already opened a place for it. */
const SNAP_EDGE_STYLE: CSSProperties = { stroke: 'oklch(0.56 0.19 260 / .85)', strokeWidth: 2.4, strokeLinecap: 'round' }
/* ── the catch zone ──
   A week catches a dragged card anywhere across the map's own columns, if the
   card is level with that week's BAND (not its header card) or within CATCH_Y of
   it. Measuring against the card was the old rule and it made the zone a ~90px
   ellipse around the header: aiming at the third slot of an open week's lane —
   the obvious place to aim — silently missed, and the drop read as broken.
   Bands don't overlap vertically, so at most one can contain a point: "which
   week" has one answer, which is why this is a band test and not a distance
   contest between neighbours. */
const CATCH_X = RIGHT_X + RES_W + 60
const CATCH_Y = 90
/* Athena's margin-note lane — OUTSIDE the materials column, on the paper's
   right edge, so her notes peek into view without joining the course timeline. */
const ATH_W = 300
/* Air between the lane's right edge and the frame in the snapped lane pose.
   Small on purpose: every pad px pushes the page title further off the LEFT
   edge at that pose (a sliced "C" in the H1 reads as a bug, not a camera).
   MUST stay below extentOf's 120px lane allowance: the snap target needs to sit
   inside the translateExtent box, or d3-zoom yanks the camera back mid-tween. */
const ATH_SNAP_PAD = 16
/* How much of a note shows at the spine pose — a SNEAK PEEK, in screen px.
   The lane's x is derived from the container width so exactly this sliver
   crosses the frame on every screen (see athXFor); the floor below keeps the
   lane clear of the materials column when the window is too narrow for that,
   where the peek shrinks to nothing and the edge affordance is the way in. */
const ATH_PEEK = 44
const ATH_X_MIN = RIGHT_X + RES_W + 64
/** Lane x for a given container width: the leftmost note edge lands ATH_PEEK
 *  screen-px inside the frame's right edge when the camera is at the spine
 *  pose (x = w/2), never closer to the spine than ATH_X_MIN. */
const athXFor = (w: number, zoom: number) => Math.max(ATH_X_MIN, (w / 2 - ATH_PEEK) / zoom)
const ATH_EST_H = 280
/* Notes flocked on one module sit closer than the lane's ordinary breathing
   room — clearly one cluster, still each readable. */
const FLOCK_GAP = 8
const ATH_EDGE_STYLE: CSSProperties = { stroke: 'oklch(0.62 0.16 295 / .55)', strokeWidth: 1.7, strokeDasharray: '2 7', strokeLinecap: 'round' }

/* height estimates drive vertical stacking (must be ≥ real height to avoid
   overlap — edges track real positions regardless once measured) */
function resHeight(r: Resource, calm: boolean): number {
  if (calm) return 60
  return r.k === 'lecture' ? (/lecture/i.test(r.t) ? 150 : 76)
    : r.k === 'video' ? 152
    : r.k === 'link' ? 96
    : r.k === 'reference' ? 78
    : r.k === 'quiz' ? 132
    : r.k === 'assignment' ? 100
    : r.k === 'image' ? 178
    : 84
}
const moduleHeight = (m: CourseModule) =>
  (m.materials.length || m.quizzes.length || m.assignments.length || m.sessions?.length) ? 150 : 106
const noteHeight = (calm: boolean) => (calm ? 60 : 66)

/** Highest divider slot in a module — dividers past the last card collapse onto
 *  the lane's foot rather than disappearing. */
const maxDividerIndex = (ds: { index: number }[]) => ds.reduce((max, d) => Math.max(max, d.index), -1)

/* getH(id, fallback) → the height to use when stacking node `id`. Defaults to
   the estimate; the measured-relayout pass swaps in real heights for constant gaps. */
function computeLayout(course: CourseModule[], open: boolean[], calm: boolean, titles: string[], weekNumbers: (number | null)[], noteAuthor: string, measured: Map<string, number>, moduleDividers: { index: number; title: string }[] = [], roofFlagged: ReadonlySet<string> = EMPTY_TITLES, artifactsByModule: Map<number, AthenaArtifactView[]> = NO_ARTIFACT_MAP, athX: number = ATH_X_MIN, unplaced: Resource[] = [], todayLabel = '', unplacedDraggable = false, todayIndex: number | null = null, drop: DropSlot | null = null, looseStacked = false): { nodes: Node[]; height: number } {
  const nodes: Node[] = []
  const segs: { top: number; phase: SpinePhase }[] = []
  const airServed = new Set<string>() // flagged titles that already got their headroom
  let y = TOP_PAD
  /* stacking height: real (measured) height when known, else estimate */
  const h = (id: string, fb: number) => measured.get(id) ?? fb
  /* Attach known dimensions so React Flow never sees a freshly-computed node as
     "unmeasured" — that would make it drop (then re-add) the edges attached to
     it, which is exactly the connector flash on expand/collapse. */
  const dim = (id: string, w: number) => (measured.has(id) ? { width: w, height: measured.get(id) as number } : undefined)

  /* ── the today-line, and the unplaced work waiting on it ──
     WHERE: the calendar's own answer first — `todayIndex`, the band hosting the
     next scheduled class (from real room dates). Only if nothing is on the
     calendar does it fall back to the end of what's been delivered, which in a
     course where every week has some delivery is the bottom of the map.
     WHAT WAITS THERE: unplaced quizzes/assignments, as ordinary cards scattered
     loose around the line until the professor drags one onto a week (professor
     only — students are never shown work that has no place yet). The line
     itself is shown to both: it says where the term is right now, which is true
     for either reader. */
  let frontier = -1
  course.forEach((m, i) => {
    if (m.draft || m.locked) return
    if (m.ongoing || m.phase === 'done' || m.phase === 'prog') frontier = i
  })
  const todayAt = todayIndex ?? frontier + 1
  const showToday = todayLabel !== '' && (todayIndex !== null || frontier >= 0)
  /* Emitted once. The slot can be MISSED — a draft module occupies it and
     returns before its band is laid out — so the call below the last module is
     the backstop rather than a second placement: unplaced work must never fall
     off the map just because the next week is still a draft. */
  let todayDone = false
  const todayBlock = (i: number) => {
    if (!showToday || todayDone || (i !== todayAt && i !== course.length)) return
    todayDone = true
    nodes.push({
      id: 'today', type: 'todayline', position: { x: WIDE_X, y }, data: { label: todayLabel, w: WIDE_W } as unknown as Record<string, unknown>,
      draggable: false, selectable: false, style: { width: WIDE_W }, measured: { width: WIDE_W, height: DIV_H }, zIndex: 2,
    })
    if (unplaced.length === 0) { y += DIV_H + MOD_GAP; return }   /* the line alone */
    y += DIV_H + UNPLACED_LEAD
    /* Two per row, one either side of the spine. `rowTop` only advances once a
       row is complete, so the pair sits level-ish (their own dy breaks it up)
       and the block below starts clear of the tallest card in it. */
    let rowTop = y
    let bottom = y
    /* Only the first UNPLACED_ON_MAP_MAX are drawn. The margin note carries the
       true total, so the tail is disclosed rather than hidden — see looseNote. */
    unplaced.slice(0, UNPLACED_ON_MAP_MAX).forEach((r, j) => {
      const id = `u${j}`
      const side = sideFor(r)
      /* Scatter x alternates sides by INDEX, not by `side`: these cards are all
         quizzes/assignments, so filing them by column here would pile every one
         into the left lane. `side` is the snap rule, not the parking spot.
         When the lanes don't fit (looseStacked), everything goes in one centred
         column on the spine — the same place the module bands sit, which is the
         only x guaranteed to be on screen. The jitter is dropped with it: it
         exists to stop two side-by-side cards looking mechanical, and in a single
         column it just pushes cards off-centre. */
      const x = looseStacked
        ? -RES_W / 2
        : (j % 2 === 0 ? LEFT_X : RIGHT_X) + UNPLACED_DX[j % UNPLACED_DX.length]
      const top = looseStacked ? rowTop : rowTop + UNPLACED_DY[j % UNPLACED_DY.length]
      nodes.push({
        id, type: 'unplaced', position: { x, y: top }, data: { r, calm, side } as unknown as Record<string, unknown>,
        draggable: unplacedDraggable, style: { width: RES_W }, measured: dim(id, RES_W), zIndex: 6,
      })
      bottom = Math.max(bottom, top + h(id, resHeight(r, calm)) + (r.skills ? SKILL_OVERHANG : 0))
      /* Stacked: every card is its own row. Two-lane: the row closes on the odd
         index, so the pair sits level-ish and the block below clears the taller. */
      if (looseStacked || j % 2 === 1) rowTop = bottom + COL_GAP
    })
    y = bottom + MOD_GAP
  }

  /* module-level dividers waiting above band `i` — a full-width line in the gap
     between the two bands, which is where a break between modules reads. */
  const wideBefore = (i: number) => {
    moduleDividers.forEach((d, k) => {
      if (d.index !== i) return
      const id = `md${k}`
      y += DIV_LEAD
      nodes.push({
        id, type: 'divider', position: { x: WIDE_X, y }, data: { title: d.title, w: WIDE_W } as unknown as Record<string, unknown>,
        draggable: false, selectable: false, style: { width: WIDE_W }, measured: { width: WIDE_W, height: DIV_H }, zIndex: 2,
      })
      y += DIV_H + DIV_GAP
    })
  }

  course.forEach((m, i) => {
    if (m.draft) return
    const title = titles[i] ?? m.title

    wideBefore(i)
    todayBlock(i)
    const bandTop = y
    segs.push({ top: bandTop, phase: phaseOf(m) })
    /* A locked week can never expand — it has nothing inside it to show, so
       leaving it collapsible would be a card that opens onto nothing. */
    const isOpen = !m.locked && open[i]
    const leftItems = isOpen ? [...m.quizzes, ...m.assignments] : []
    const rightItems = isOpen ? m.materials.filter((r) => r.k !== 'note') : []
    const notes = isOpen ? m.materials.filter((r) => r.k === 'note') : []
    /* Live room + past/scheduled sessions now hang UNDER the card on the spine
       (with the notes) as part of this module — not as separate blocks floating
       above it. Shown when the module is open, like the rest of the band. */
    const sessions = isOpen ? (m.sessions || []) : []
    const showLive = isOpen && m.live

    /* Headroom for a roof flag on this card (see FLAG_AIR). Served once per
       flagged title: the annotation layer resolves a target to the FIRST matching
       node, so on a course with two identically-titled cards only one gets the
       flag — reserving air on both would leave the other with an unexplained 52px
       hole that reads as a section break. */
    const air = (title: string) => {
      if (!roofFlagged.has(title) || airServed.has(title)) return 0
      airServed.add(title)
      return FLAG_AIR
    }

    /* The place this band is holding open for a card being dragged onto it: an
       empty slot at the exact index the placement will give it — the end of its
       own kind-group, since a lane is quizzes-then-assignments and nothing finer
       is stored. So a quiz opens its slot under the last quiz, and the
       assignments below it (and every band under this one) slide down to make
       room, rather than the room appearing at the bottom of a long lane where
       the professor may not even be able to see it. */
    const dropAt = !drop || drop.moduleIdx !== i ? -1
      : drop.side === 'R' ? rightItems.length
      : drop.kind === 'quiz' ? m.quizzes.length
      : leftItems.length
    const dropIn = (side: 'L' | 'R', at: number, slot: number) => {
      if (!drop || drop.moduleIdx !== i || drop.side !== side || slot !== dropAt) return at
      nodes.push({
        id: 'drop', type: 'dropslot', position: { x: side === 'L' ? LEFT_X : RIGHT_X, y: at },
        data: { h: drop.h } as unknown as Record<string, unknown>,
        draggable: false, selectable: false, style: { width: RES_W },
        measured: { width: RES_W, height: drop.h }, zIndex: 1,
      })
      return at + drop.h + COL_GAP
    }

    let ly = bandTop
    leftItems.forEach((r, j) => {
      ly = dropIn('L', ly, j)
      ly += air(r.t)
      const id = `m${i}-L${j}`
      nodes.push({ id, type: 'resource', position: { x: LEFT_X, y: ly }, data: { r, calm, side: 'L', jit: (i + j) % 4, delay: j * 0.06 } as unknown as Record<string, unknown>, style: { width: RES_W }, measured: dim(id, RES_W), zIndex: 3 })
      ly += h(id, resHeight(r, calm)) + (r.skills ? SKILL_OVERHANG : 0) + COL_GAP
    })
    ly = dropIn('L', ly, leftItems.length)
    let ry = bandTop
    /* the module's own dividers, drawn in the materials lane between the cards
       they separate (index = how many cards sit above the line) */
    const inModule = isOpen ? m.dividers ?? [] : []
    const dividerAt = (slot: number) => {
      inModule.forEach((d, k) => {
        if (d.index !== slot) return
        const id = `m${i}-d${k}`
        nodes.push({
          id, type: 'divider', position: { x: RIGHT_X, y: ry }, data: { title: d.title, w: RES_W } as unknown as Record<string, unknown>,
          draggable: false, selectable: false, style: { width: RES_W }, measured: { width: RES_W, height: DIV_H }, zIndex: 3,
        })
        ry += DIV_H + COL_GAP
      })
    }
    rightItems.forEach((r, j) => {
      dividerAt(j)
      ry += air(r.t)
      const id = `m${i}-R${j}`
      nodes.push({ id, type: 'resource', position: { x: RIGHT_X, y: ry }, data: { r, calm, side: 'R', jit: (i + j) % 4, delay: j * 0.06 } as unknown as Record<string, unknown>, style: { width: RES_W }, measured: dim(id, RES_W), zIndex: 3 })
      ry += h(id, resHeight(r, calm)) + (r.skills ? SKILL_OVERHANG : 0) + COL_GAP
    })
    /* a divider past the last card (or every one of them, in a module whose
       materials are all notes) still belongs on the map — at the lane's foot */
    for (let slot = rightItems.length; slot <= maxDividerIndex(inModule); slot++) dividerAt(slot)
    ry = dropIn('R', ry, rightItems.length)

    /* Athena's margin notes for this module, in their own lane right of the
       materials — left-aligned in a clean column; a flock (2+) sits with a
       tighter gap so the cluster still reads as one group. */
    const arts = isOpen ? (artifactsByModule.get(i) ?? []) : []
    let ay = bandTop
    arts.forEach((a, j) => {
      const id = `m${i}-A${j}`
      nodes.push({ id, type: 'athena', position: { x: athX, y: ay }, data: { a, j } as unknown as Record<string, unknown>, style: { width: ATH_W }, measured: dim(id, ATH_W), zIndex: 3 + j })
      ay += h(id, ATH_EST_H) + (arts.length > 1 ? FLOCK_GAP : COL_GAP)
    })

    const mid = `m${i}`
    const mh = h(mid, moduleHeight(m))
    nodes.push({ id: mid, type: 'module', position: { x: MOD_X, y: bandTop }, data: { m: { ...m, title }, idx: i, open: isOpen, weekNumber: weekNumbers[i] ?? null } as unknown as Record<string, unknown>, style: { width: MOD_W }, measured: dim(mid, MOD_W), zIndex: 5 })

    /* center spine column under the card: notes, then the live room, then sessions */
    let ny = bandTop + mh + COL_GAP
    notes.forEach((n, j) => {
      const id = `m${i}-n${j}`
      nodes.push({ id, type: 'note', position: { x: NOTE_X, y: ny }, data: { note: n, calm, i: j, delay: j * 0.06, author: noteAuthor } as unknown as Record<string, unknown>, style: { width: NOTE_W }, measured: dim(id, NOTE_W), zIndex: 4 })
      ny += h(id, noteHeight(calm)) + COL_GAP
    })
    if (showLive) {
      const id = `m${i}-live`
      nodes.push({ id, type: 'live', position: { x: LIVE_X, y: ny }, data: { room: m.liveRoom } as unknown as Record<string, unknown>, style: { width: LIVE_W }, measured: dim(id, LIVE_W), zIndex: 4 })
      ny += h(id, 96) + COL_GAP
    }
    sessions.forEach((s, j) => {
      ny += air(s.t)
      const id = `m${i}-s${j}`
      nodes.push({ id, type: 'session', position: { x: SESS_X, y: ny }, data: { s } as unknown as Record<string, unknown>, style: { width: SESS_W }, measured: dim(id, SESS_W), zIndex: 4 })
      ny += h(id, s.ints?.length ? 122 : 92) + COL_GAP
    })

    const bandH = Math.max(ly - bandTop, ry - bandTop, ny - bandTop, ay - bandTop, mh)
    y = bandTop + bandH + MOD_GAP
  })
  wideBefore(course.length) /* a divider dragged below the last module */
  todayBlock(course.length)  /* every module delivered → today sits below them all */

  /* one coloured segment per module, contiguous top→bottom. The first segment
     absorbs the top padding; the last runs to the full height. */
  const segments = segs.map((s, i) => ({
    height: Math.max(0, (i < segs.length - 1 ? segs[i + 1].top : y) - (i === 0 ? 0 : s.top)),
    phase: s.phase,
  }))
  nodes.unshift({
    id: 'spine', type: 'spine', position: { x: -2, y: 0 }, data: { height: y, segments } as unknown as Record<string, unknown>,
    draggable: false, selectable: false, zIndex: 0, style: { width: 4, pointerEvents: 'none' }, measured: { width: 4, height: y },
  })
  return { nodes, height: y }
}

/* Edges depend ONLY on which modules are open (source/target ids are index-
   based) — never on positions, calm, or measured heights. Computing them
   separately keeps the edges array referentially stable across the measured
   re-layout, so React Flow never tears down and redraws the connectors. */
function computeEdges(course: CourseModule[], open: boolean[], artifactsByModule: Map<number, AthenaArtifactView[]> = NO_ARTIFACT_MAP, drag: { id: string; moduleIdx: number; side: 'L' | 'R' } | null = null): Edge[] {
  const edges: Edge[] = []
  /* An unplaced card carries NO edge at rest — it isn't tied to anything, which
     is the whole point of it. The one edge it ever gets is while it's being
     dragged inside a module's reach: the connector the placement will make,
     drawn exactly like the module's own, so the drop holds no surprise. */
  if (drag && drag.moduleIdx >= 0) {
    edges.push({
      id: `e-${drag.id}`, source: `m${drag.moduleIdx}`, sourceHandle: drag.side === 'L' ? 'l' : 'r',
      target: drag.id, targetHandle: drag.side === 'L' ? 'r' : 'l', style: SNAP_EDGE_STYLE,
    })
  }
  course.forEach((m, i) => {
    if (m.draft || m.locked || !open[i]) return
    const leftCount = m.quizzes.length + m.assignments.length
    const rightCount = m.materials.filter((r) => r.k !== 'note').length
    for (let j = 0; j < leftCount; j++) {
      const id = `m${i}-L${j}`
      edges.push({ id: `e-${id}`, source: `m${i}`, sourceHandle: 'l', target: id, targetHandle: 'r', style: EDGE_STYLE })
    }
    for (let j = 0; j < rightCount; j++) {
      const id = `m${i}-R${j}`
      edges.push({ id: `e-${id}`, source: `m${i}`, sourceHandle: 'r', target: id, targetHandle: 'l', style: EDGE_STYLE })
    }
    /* Athena's notes tether to the module in her own ink — a lighter, dottier
       violet — so the tie reads as marginalia, not course structure. */
    const artCount = artifactsByModule.get(i)?.length ?? 0
    for (let j = 0; j < artCount; j++) {
      const id = `m${i}-A${j}`
      edges.push({ id: `e-${id}`, source: `m${i}`, sourceHandle: 'r', target: id, targetHandle: 'l', style: ATH_EDGE_STYLE })
    }
  })
  return edges
}

/* overall completion roll-up — the same tally the module cards keep, summed
   across the visible course: materials (notes are informational, excluded),
   quizzes, assignments, and sessions (held = done). */
function progressOf(course: CourseModule[]): { done: number; prog: number; todo: number; total: number; pct: number } {
  let done = 0, prog = 0, total = 0
  for (const m of course) {
    // A skipped module (or one with nothing derivable) leaves BOTH sides of the
    // sum, exactly as it leaves each module card's own percentage — otherwise
    // this headline would contradict the cards right below it.
    /* A week that isn't open yet leaves both sides of the sum, like a skipped one:
       the student can't have finished work they can't reach, and counting it would
       make the headline drop every time the professor adds a future module. */
    if (m.draft || m.excluded || m.locked) continue
    const items = [...m.materials.filter((r) => r.k !== 'note'), ...m.quizzes, ...m.assignments]
    for (const r of items) {
      // Statusless cards (supplementary material under coverage) are not
      // completable by the professor, so counting them would make 100%
      // unreachable for any course holding a single reference link. For a
      // student they ARE completable, so `tickable` keeps them counted — this
      // headline must agree with the module cards underneath it.
      if (!r.st && !r.tickable) continue
      total++
      if (r.st === 'done') done++
      else if (r.st === 'prog') prog++
    }
    /* The live room is in this sum too: it renders as the LIVE node rather than a
       session tile, but the coverage engine counts every placed live_session in
       the module percentages this headline has to agree with. It counts as
       in-progress, not done — the class has started, not finished. */
    for (const s of [...(m.sessions ?? []), ...(m.liveRoom ? [m.liveRoom] : [])]) {
      total++
      if (s.live) prog++
      else if (!s.sched) done++
    }
  }
  return { done, prog, todo: total - done - prog, total, pct: total ? Math.round((100 * done) / total) : 0 }
}

/* pannable bounds — the content box + a little padding, so panning/scrolling
   can't drift into empty space above the first block or below the last (the
   top allowance leaves room for the completion station above the spine) */
const EXTENT_X = RES_W + Math.abs(LEFT_X) + 120
/* the pannable box's allowance ABOVE y=0 — room for the page title, the
   completion station, and a calm band of paper above the title so it doesn't
   press against the canvas edge. resetView loads the map fully scrolled up:
   the viewport's top edge sits exactly on this line. */
const TOP_ALLOWANCE = 360

/* While the dossier card claims the left strip, the camera is shifted RIGHT by
   that strip (see the lens-anchoring effect) — so x deliberately sits somewhere
   d3-zoom's constrain() will not allow, it yanks x back, onMove's spine pin
   re-sets it, and the two ping-pong on every scroll event.
   The horizontal bound is therefore RELEASED while the lens is on. Widening it
   by a fixed pad cannot work: once the viewport is wider than the extent box,
   constrain() stops clamping an edge and force-CENTRES the box instead (its
   `dx1 > dx0` branch), which pins x to exactly w/2 — so the pad would have to
   exceed the widest viewport we ever run in, and a 4K full-screen canvas needs
   ~2900 world units of it. Releasing x costs nothing real: default mode offers
   no horizontal gesture at all and the pin holds the spine centred, and Pan &
   zoom can always be toggled to snap back. The VERTICAL bound — the one that
   stops a scroll drifting into blank paper above the first block or below the
   last — is untouched. */
const NO_X_BOUND = 1e7

/* Athena's lane sits past the materials column, so with artifacts on the map
   the right bound stretches to reach it (lens release above still wins).
   `athX` = the lane's width-derived x, null when the lane isn't on the map. */
const extentOf = (height: number, lensOn = false, athX: number | null = null): [[number, number], [number, number]] => [
  [lensOn ? -NO_X_BOUND : -EXTENT_X, -TOP_ALLOWANCE],
  [lensOn ? NO_X_BOUND : athX != null ? athX + ATH_W + 120 : EXTENT_X, Math.max(height, 400) + 60],
]

/* default-view zoom: fit the annotations, never magnify, floor at 0.8 — the
   full reasoning lives at the old call site in resetView. Module-scope (it is
   a pure function of constants) so the layout memo can derive the lane's x
   from the container width without ordering games. */
const fitZoom = (w: number) => {
  const needed = Math.max(Math.abs(LEFT_X), RIGHT_X + RES_W) + ANNOTATION_REACH + 12
  return Math.max(0.8, Math.min(1, w / 2 / needed))
}

/* ════════════════════════════════════════════════════════════════
   G · NODE DETAIL — the click-through opening behaviour, ported from
       RoadmapNodeModal.tsx and revamped to this design's vibe (the
       "dream cloud"): LEFT column = the resource's own content, RIGHT
       rail = status · breadcrumb · summary · Open CTA · skills (mastery
       tones + skill→question/page reference jumps). Notes are
       standalone (no click-through); link/video open a new tab.
       All demo content — the question/rubric/poll texts are fabricated
       stand-ins for what the production lazy-fetchers would return.
   ════════════════════════════════════════════════════════════════ */
type DetailKind = Kind | 'session' | 'live' | 'athena'
interface DetailItem {
  k: DetailKind
  t: string
  s?: string
  /** athena only: the artifact whose interactive body the modal renders. */
  artifact?: AthenaArtifactView
  fmt?: Resource['fmt']
  skills?: [string, Tier][]
  more?: number
  sched?: boolean
  ints?: [IntKind, string][]
  ctx?: string /* parent module title → the breadcrumb */
  sum?: string
  /** canvas key (`module_item:{id}`) — carried in via the Resource spread. The
   *  check-off itself is stored under the RAW id (see selfCheckFor). */
  key?: string
  /** student view: this is supplementary material they can tick off. */
  tickable?: boolean
  /** Derived coverage state, spread in from the Resource. `''` = statusless
   *  supplementary material, which has no coverage to report at all. */
  st?: Resource['st']
  /** Deck coverage, spread in from the Resource — pairs with `pages` below for
   *  the "18 of 30" the STATUS chip reports. */
  covered?: Resource['covered']
  /** quiz/assignment, professor only: released but nobody has begun (P21). */
  openUntouched?: Resource['openUntouched']
  /** professor only: `is_visible = false` — students can't see this yet. */
  hidden?: Resource['hidden']
  href?: string
  /** the uploaded file, rendered inline on the LEFT (see Resource.file). */
  file?: Resource['file']
  /** skill label → the file's pages citing it (the citation rail). */
  topicPages?: Resource['topicPages']
  /** page/slide count of `file` — sizes the citation rail. */
  pages?: number
}

/** Supplementary material — the kinds a student completes themselves (§14.1). */
const EXTRA_KINDS = new Set<DetailKind>(['video', 'image', 'reference', 'link'])
/* Kinds whose body is a scrolling list beside a citation rail. They need the
   column to FILL and CLIP (like a file node) — the rail is absolutely
   positioned inside .pwrap, so without a bounded parent it runs off the card. */
const RAILED_KINDS = new Set<DetailKind>(['quiz', 'session', 'live'])

const DKIND_LABEL: Record<DetailKind, string> = {
  lecture: 'lecture', video: 'video', link: 'link', reference: 'reference', note: 'note', image: 'image',
  quiz: 'quiz', assignment: 'assignment', session: 'live session', live: 'live session',
  athena: 'from Athena',
}
/** The file's pages that cite `skill` — the citation rail's targets. Real data
 *  (semantic page hits from extraction), so a skill with no hits gets no rail. */
function citedPages(item: DetailItem, skill: string): number[] {
  return (item.topicPages?.[skill] ?? []).filter((p) => p > 0)
}

/** Fetched-on-open content: `null` while in flight, then loaded or failed.
 *  Distinguishing the two matters — every one of these kinds has an empty state
 *  that looks exactly like a failure ("no questions", "nothing ran here"). */
type Loaded<T> = { ok: true; data: T } | { ok: false } | null

/** How many cross-refs one verb shows before collapsing into "+N more". */
const XREF_CAP = 3

/** The cross-ref lines for one skill: at most one "Taught in …" and one
 *  "Assessed by …", each a comma-joined list — the shape material-viewer uses
 *  for the same data. One ROW per title looked fine against the old synthetic
 *  1-and-1, but real courses reach four assessments on a single skill, which
 *  buried the rest of the rail. `self` drops the node we are already looking at
 *  (normalised: the two titles come from different sources). */
function crossRefs(refs: ConceptRefs | undefined, self: string): { verb: string; titles: string[]; extra: number }[] {
  if (!refs) return []
  const selfKey = normalizeTopicKey(self)
  const line = (verb: string, all: string[]) => {
    const kept = all.filter((t) => normalizeTopicKey(t) !== selfKey)
    return { verb, titles: kept.slice(0, XREF_CAP), extra: Math.max(0, kept.length - XREF_CAP) }
  }
  return [line('Taught in', refs.taughtIn), line('Assessed by', refs.assessedBy)].filter((l) => l.titles.length > 0)
}

/* status resolution — resources show their LIFECYCLE word; items the 3-state word */
function statusOf(item: DetailItem, audience: 'prof' | 'stu'): { label: string; cls: string } | null {
  if (item.k === 'quiz' || item.k === 'assignment') {
    const word = (item.s || '').split(' ')[0].replace(/[^A-Za-z]/g, '')
    return { label: word || 'Draft', cls: word === 'Published' ? 'prog' : 'todo' }
  }
  if (item.k === 'session') return item.sched ? { label: 'Scheduled', cls: 'todo' } : { label: 'Ended', cls: 'done' }
  if (item.k === 'live') return { label: 'Live', cls: 'prog' }
  /* Everything else reads the coverage the engine DERIVED for this node. This was
     a hardcoded 'Not started', which made the drawer contradict the card it opened
     from — a deck showing "18 / 30" and styled in-progress, or a finished one under
     a 100% module, both reported "Not started" — and it never moved for a student
     who had just passed the node's quick check. */
  /* Wording follows the audience: a professor reads class COVERAGE, but a
     student's `done` came from their own tick — and the control beside this chip
     says "Mark as done", so "Covered" would answer a personal action in
     class-aggregate vocabulary. */
  if (item.st === 'done') return { label: audience === 'stu' ? 'Done' : 'Covered', cls: 'done' }
  if (item.st === 'prog') {
    // Say WHERE it got to when the deck exposes an honest fraction.
    const frac = item.covered != null && item.pages ? ` · ${item.covered} of ${item.pages}` : ''
    return { label: `In progress${frac}`, cls: 'prog' }
  }
  if (item.st === 'todo') return { label: 'Not started', cls: 'todo' }
  /* Statusless supplementary material (a reference link a professor never
     "delivers"): no coverage exists, so the drawer states none rather than
     inventing a "Not started" the engine never derived. */
  return null
}
/* footer CTA — ended rooms and standalone items get none (production rule) */
function ctaLabel(item: DetailItem): { label: string; glyph: string } | null {
  switch (item.k) {
    case 'quiz': return { label: 'Open quiz', glyph: '↗' }
    case 'assignment': return { label: 'Open assignment', glyph: '↗' }
    case 'session': return !item.href ? null
      : item.sched ? { label: 'Open room', glyph: '↗' }
        : { label: 'Class insights', glyph: '↗' }
    case 'live': return { label: 'Join the room', glyph: '↗' }
    case 'reference': return { label: 'Open paper', glyph: '↗' }
    // Nothing uploaded → no download. The left column already says so; a styled
    // button that does nothing when pressed is worse than no button.
    case 'lecture': return item.file ? { label: `Download ${item.fmt || 'PDF'}`, glyph: '⤓' } : null
    // A student who can tick these lands in the modal instead of jumping
    // straight out, so the jump has to be here (see onNodeClick).
    case 'video': return item.tickable ? { label: 'Watch video', glyph: '↗' } : null
    case 'link': return item.tickable ? { label: 'Open link', glyph: '↗' } : null
    default: return null
  }
}

/* the detail card — remounts per node (keyed by node id at the call site), so the
   active-skill / current-page state resets on open and on cross-ref navigation. */
function NodeDetail({ item, onClose, onNavigate, aiTutorHref, selfCheck, nodeCheck, nodeCheckReview, loadQuizQuestions, loadAssignmentContent, loadSessionContent, conceptRefs, navigable, audience, sectionId, onSaveArtifactState, onArchiveArtifact, onArchiveNode }: {
  item: DetailItem
  onClose: () => void
  onNavigate: (title: string) => void
  /** The quiz's real questions, fetched on open (role-scoped by the caller). */
  loadQuizQuestions?: (quizId: string) => Promise<{ data?: RoadmapDrawerQuestion[]; error?: string }>
  /** The assignment's real brief (description · guidelines · rubric). */
  loadAssignmentContent?: (assignmentId: string) => Promise<{ data?: RoadmapDrawerAssignment; error?: string }>
  /** What actually ran in a live room — its polls and pop-quizzes. */
  loadSessionContent?: (roomId: string) => Promise<{ data?: RoadmapDrawerSession; error?: string }>
  /** Per-skill "taught in" / "assessed by", by normalised skill name. */
  conceptRefs?: Record<string, ConceptRefs>
  /** Who is reading — a student is shown less of an unreleased activity. */
  audience: 'prof' | 'stu'
  /** Needed to log a student's material opens (see logMaterial below). */
  sectionId?: string
  /** Node titles the map can actually swap to — a cross-ref to anything else is
   *  still worth showing, but as text rather than a button that does nothing. */
  navigable?: Set<string>
  /** Student-only: the course path Athena's `?athena-topic=` deep link hangs off —
   *  a weak/shaky skill opens the palette prefilled with that topic. */
  aiTutorHref?: string
  /** Student-only: tick supplementary material as gone-through (§14.1). Absent
   *  for professors, and for material the professor actually delivers. */
  selfCheck?: { checked: boolean; saving: boolean; onToggle: () => void }
  /** Student-only: the generated check for this item, when one can exist. The
   *  right rail falls back to `selfCheck` whenever the generator found nothing
   *  to ask. */
  nodeCheck?: NodeCheckActions
  /** Professor-only: review of the lens-selected student's check (§14.2). */
  nodeCheckReview?: NodeCheckReviewPanelProps
  /** Student-only: persist interaction state on an Athena artifact (§15). */
  onSaveArtifactState?: (artifactId: string, state: ArtifactState) => Promise<{ success?: true; error?: string }>
  /** Student-only: park an Athena artifact in the Archive tray. */
  onArchiveArtifact?: (artifactId: string, archived: boolean) => Promise<{ success?: true; error?: string }>
  /** Professor-only: take THIS node off the map. Absent = no archive action (the
   *  student view, and any node without a stable key). The canvas owns the
   *  optimistic update, the receipt and its undo chip. */
  onArchiveNode?: (nodeKey: string, title: string) => void
}) {
  const [activeSkill, setActiveSkill] = useState<string | null>(null)
  /* athena only: the Archive action's in-flight guard. */
  const [removing, setRemoving] = useState(false)
  /* Where the citation rail has jumped to: a PAGE on a file node, a QUESTION
     NUMBER on a quiz or session. One node is never both, so one piece of state
     serves every rail. null = nothing jumped to yet, so a file opens at its own
     pinned page rather than being forced back to page 1. */
  const [anchor, setAnchor] = useState<number | null>(null)
  /* full-screen: the card takes over the whole canvas (and the file viewer gets
     its own toolbar back) */
  const [full, setFull] = useState(false)
  /* Escape steps OUT of full screen rather than discarding the node — that's how
     every full-screen surface behaves, and reopening would reset the selected
     skill and page (this card remounts per node). Capture phase so it lands
     before the canvas's own Escape → closeDetail handler. */
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setFull(false)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [full])
  const cardRef = useRef<HTMLDivElement>(null)
  /* One load, read by two columns: the questions render in the middle, and the
     right rail offers the plain tick only once we know no check will take its
     place. Already ticked → re-offering a check they have satisfied would just
     be noise, so it is never asked for. */
  const checkOffered = !!nodeCheck && !selfCheck?.checked
  const check = useNodeCheck(checkOffered ? nodeCheck : undefined)
  const gate = completionControls({ offered: !!nodeCheck, checked: !!selfCheck?.checked, view: check.view })
  const checkInMain = gate.showCheck
  const showTick = !!selfCheck && gate.showTick

  const st = statusOf(item, audience)
  const cta = ctaLabel(item)
  const cvar = cssVars({ '--c': `var(--c-${item.k === 'live' ? 'live' : item.k})` })
  const chipCls = item.k === 'live' ? 'liv' : st?.cls === 'prog' ? 'prog' : st?.cls === 'done' ? 'done' : ''
  /* a k='lecture' upload that isn't a lecture deck (a syllabus DOC, a grade XLS,
     a starter-code ZIP, a bare PDF) reads as a "file", not a "lecture" */
  const isFile = item.k === 'lecture' && !/lecture/i.test(item.t)
  const kindLabel = isFile ? 'file' : (DKIND_LABEL[item.k] || item.k)
  /* The id behind this node, for the kinds whose content is fetched on open.
     parseNodeKey (not a hand-counted slice) because it splits on the FIRST
     colon — and because a wrong offset yields a valid-looking id whose fetch
     returns nothing, which renders as "this quiz is empty". */
  const idOfKind = (...kinds: DrawerNodeKind[]): string | null => {
    if (!item.key) return null
    const ref = parseNodeKey(item.key)
    return kinds.includes(ref.type) && ref.id ? ref.id : null
  }

  /* Engagement signals for material opened FROM THE ROADMAP.
     Every `material.*` event used to come from StudentModuleItemRow alone, so a
     student who worked entirely from the roadmap looked like they had opened
     nothing — and the signals built on these events (`noOpens`, `newSinceVisit`,
     `reDownloads`, `clickThroughs`, `youAreHere`) drive the professor's triage
     annotations. Student-only: a professor reading their own material is not an
     engagement signal. Fire-and-forget, same as the Modules page. */
  const materialItemId = idOfKind('module_item')
  const logMaterial = useCallback((kind: 'viewed' | 'link_clicked' | 'downloaded') => {
    if (audience !== 'stu' || !sectionId || !materialItemId) return
    void logMaterialEvent(sectionId, materialItemId, kind)
  }, [audience, sectionId, materialItemId])
  /* An inline preview IS the view — the drawer renders the file itself, so there
     is no separate "open" to hang this off (the Modules page logs `viewed` when it
     opens its viewer). Once per mounted card: NodeDetail is keyed by node id, so
     navigating between nodes remounts and each one counts once. */
  const hasFilePreview = !!item.file
  useEffect(() => {
    if (hasFilePreview) logMaterial('viewed')
  }, [hasFilePreview, logMaterial])

  /* A quiz's real questions. Fetched on open rather than shipped with the map:
     a course carries dozens of quizzes and nobody opens more than a few. `null`
     while in flight; `ok:false` is "we couldn't read it", which must not be
     dressed up as the empty quiz it looks identical to. `[]` IS a real answer:
     no questions written, or a student looking at an unpublished quiz (the
     action hands back an empty list rather than a draft's question text). */
  const quizId = item.k === 'quiz' ? idOfKind('quiz') : null
  const [questions, setQuestions] = useState<Loaded<RoadmapDrawerQuestion[]>>(null)
  useEffect(() => {
    if (!quizId || !loadQuizQuestions) return
    let alive = true
    void loadQuizQuestions(quizId)
      .then((res) => { if (alive) setQuestions(res.data ? { ok: true, data: res.data } : { ok: false }) })
      .catch(() => { if (alive) setQuestions({ ok: false }) })
    return () => { alive = false }
  }, [quizId, loadQuizQuestions])

  /* What ran in a live room — its polls and pop-quizzes, with the skills each
     was tagged with. Same terms as the quiz's questions. Both the ended-session
     tile and the live-now room are lc_rooms, so both read from here. */
  const roomId = item.k === 'session' || item.k === 'live' ? idOfKind('live_session') : null
  const [ran, setRan] = useState<Loaded<RoadmapDrawerSession['children']>>(null)
  useEffect(() => {
    if (!roomId || !loadSessionContent) return
    let alive = true
    void loadSessionContent(roomId)
      .then((res) => { if (alive) setRan(res.data ? { ok: true, data: res.data.children } : { ok: false }) })
      .catch(() => { if (alive) setRan({ ok: false }) })
    return () => { alive = false }
  }, [roomId, loadSessionContent])

  /* An assignment's brief, on the same terms. */
  const assignmentId = item.k === 'assignment' ? idOfKind('assignment') : null
  const [brief, setBrief] = useState<Loaded<RoadmapDrawerAssignment>>(null)
  useEffect(() => {
    if (!assignmentId || !loadAssignmentContent) return
    let alive = true
    void loadAssignmentContent(assignmentId)
      .then((res) => { if (alive) setBrief(res.data ? { ok: true, data: res.data } : { ok: false }) })
      .catch(() => { if (alive) setBrief({ ok: false }) })
    return () => { alive = false }
  }, [assignmentId, loadAssignmentContent])

  /* Which units the SELECTED skill is cited on — pages for a file, question
     numbers for a quiz. Nothing is selected on open: the rail answers "where is
     this skill?", so it appears only once a skill on the right is clicked. */
  const citedUnits = useCallback(
    (skill: string): number[] => {
      if (item.file) return citedPages(item, skill)
      if (questions?.ok) return questionNumbersForSkill(questions.data, skill)
      // A room's children anchor the same way — their `skills` are the tags.
      if (ran?.ok) return questionNumbersForSkill(ran.data.map((c) => ({ tags: c.skills })), skill)
      return []
    },
    [item, questions, ran],
  )
  //  Rendered in unit order (a file's stored hits are in similarity-rank order,
  //  which is what the skill click jumps to first).
  const railUnits = useMemo(
    () => (activeSkill ? [...citedUnits(activeSkill)].sort((a, b) => a - b) : []),
    [activeSkill, citedUnits],
  )

  /* Bring the jumped-to question into view. One effect owns it, wherever the
     jump came from (a skill click or a rail pill). A file node needs none of
     this — the viewer takes the page number and moves itself. */
  useEffect(() => {
    if (item.file || anchor === null) return
    cardRef.current?.querySelector(`[data-q="${anchor}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [anchor, item.file])

  const toggleSkill = (name: string, units: number[]) => {
    const next = activeSkill === name ? null : name
    setActiveSkill(next)
    setAnchor(next && units.length ? units[0] : null)
  }

  /**
   * The citation rail, shared by the file viewer and the quiz list.
   *
   * A MINIMAP, not a list: each pill sits at its unit's position down the
   * column (first at the top, last at the bottom), nudged down by a minimum gap
   * when two would collide. `span` is the total length the rail maps over —
   * page count, or question count.
   */
  const renderRail = (span: number, label: (n: number) => string, group: string) => {
    if (!railUnits.length) return null
    const total = Math.max(span, ...railUnits)
    const GAP = 6 // minimum % of the rail between two pill centres
    let prev = -Infinity
    return (
      <div className="prail" role="group" aria-label={group}>
        {railUnits.map((u) => {
          const top = Math.min(Math.max(((u - 0.5) / total) * 100, prev + GAP), 100)
          prev = top
          return (
            <button
              key={u}
              type="button"
              style={{ top: `${top}%` }}
              className={`pchip${anchor === u ? ' on' : ''}`}
              aria-label={label(u)}
              aria-pressed={anchor === u}
              title={label(u)}
              onClick={() => setAnchor(u)}
            >{u}</button>
          )
        })}
      </div>
    )
  }

  /* LEFT content, one branch per kind (mirrors the prototype's dQuiz/dAssignment/
     dSession/dLive/dLecture/dReference). */
  const renderMain = () => {
    switch (item.k) {
      /* Athena's study artifact — the interactive widget IS the content.
         Dispatch lives in ArtifactWidgets; this modal only hosts it. */
      case 'athena':
        return item.artifact
          ? <AthenaArtifactBody artifact={item.artifact} onSaveState={onSaveArtifactState} />
          : <div className="dempty">Couldn&apos;t load this note.</div>
      case 'quiz': {
        if (questions === null) return <div className="dempty">loading the questions…</div>
        if (!questions.ok) return <div className="dempty">Couldn&apos;t load this quiz&apos;s questions.</div>
        const qs = questions.data
        if (qs.length === 0) {
          // A student gets an empty list for a quiz that isn't published (the
          // action refuses to hand out a draft's question text). Telling them
          // it has no questions is simply false — it has questions they may
          // not see yet. A professor reads drafts fine, so for them empty is
          // genuinely empty.
          // `st` is always set for a quiz (statusOf's own quiz branch); the guard
          // is for the type, and errs toward "not released" rather than claiming
          // a quiz is empty.
          return audience === 'stu' && st?.label !== 'Published'
            ? <div className="dempty">This quiz hasn&apos;t been released yet.</div>
            : <div className="dempty">No questions in this quiz yet.</div>
        }
        return (
          <>
            <div className="dlabel">QUESTIONS · {qs.length}</div>
            <div className="pwrap">
              <div className="qscroll">
                {qs.map((q, i) => {
                  const n = i + 1
                  const tagged = !!activeSkill && q.tags.some((t) => skillNamesMatch(t, activeSkill))
                  return (
                    <div key={q.id} data-q={n} className={`drow${tagged ? ' hl' : ''}${anchor === n ? ' tgt' : ''}`}>
                      <span className="no">{n}</span>
                      <div>
                        <div className="qt">{q.text || 'Untitled question'}</div>
                        <div className="qm">
                          {q.type ? <span className="dbadge">{q.type.replace(/_/g, ' ')}</span> : null}
                          {q.difficulty ? <span className="dbadge">{q.difficulty}</span> : null}
                          <span className="dbadge">{q.points} pt{q.points === 1 ? '' : 's'}</span>
                          {q.tags.map((t) => <span key={t} className="dbadge tag">{t}</span>)}
                        </div>
                      </div>
                    </div>
                  )
                })}
                <div className="dfoot">editing questions happens in the quiz editor.</div>
              </div>
              {renderRail(qs.length, (n) => `Jump to question ${n}`, `Questions on ${activeSkill}`)}
            </div>
          </>
        )
      }
      case 'assignment': {
        if (brief === null) return <div className="dempty">loading the brief…</div>
        if (!brief.ok) return <div className="dempty">Couldn&apos;t load this assignment&apos;s brief.</div>
        const { description, guidelines, criteria } = brief.data
        if (!description && !guidelines && criteria.length === 0) {
          return <div className="dempty">This assignment has no description or rubric yet.</div>
        }
        return (
          <>
            {description ? (<><div className="dlabel">DESCRIPTION</div><div className="dtext">{description}</div></>) : null}
            {guidelines ? (<><div className="dlabel">GUIDELINES</div><div className="dtext">{guidelines}</div></>) : null}
            {criteria.length ? (
              <>
                <div className="dlabel">RUBRIC · {criteria.length}</div>
                <ul className="drub">{criteria.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </>
            ) : null}
          </>
        )
      }
      // Both kinds are lc_rooms and read the same interactions; only the tense
      // differs. (The live branch used to render a hardcoded "Attendance · 14
      // students in the room" — invented, like the rest of this modal was.)
      case 'live':
      case 'session': {
        const heading = item.k === 'live' ? 'SO FAR IN THIS ROOM' : 'RAN IN THIS ROOM'
        if (ran === null) return <div className="dempty">loading what ran in this room…</div>
        if (!ran.ok) return <div className="dempty">Couldn&apos;t load what ran in this room.</div>
        const items = ran.data
        if (!items.length) return (<><div className="dlabel">{heading}</div><div className="dempty">This session has no polls or pop-quizzes yet.</div></>)
        const badge: Record<'live_poll' | 'live_quiz', string> = { live_poll: 'Poll', live_quiz: 'Pop quiz' }
        const glyph: Record<'live_poll' | 'live_quiz', IntKind> = { live_poll: 'poll', live_quiz: 'lquiz' }
        return (
          <>
            <div className="dlabel">{heading} · {items.length}</div>
            <div className="pwrap">
              <div className="qscroll">
                {items.map((c, i) => {
                  const n = i + 1
                  const tagged = !!activeSkill && c.skills.some((t) => skillNamesMatch(t, activeSkill))
                  return (
                    <div key={c.id} data-q={n} className={`drow${tagged ? ' hl' : ''}${anchor === n ? ' tgt' : ''}`}>
                      <span className="no">{n}</span>
                      <div>
                        {/* The prompt is what was actually asked; the title is the
                            room's own label for it and is often just "Poll 2". */}
                        <div className="qt">{c.prompt || c.title}</div>
                        <div className="qm">
                          <span className="dbadge">{badge[c.kind]}</span>
                          {c.skills.map((t) => <span key={t} className="dbadge tag">{t}</span>)}
                        </div>
                      </div>
                      <span className={`irow i-${glyph[c.kind]}`} style={{ marginLeft: 'auto', flex: 'none' }}>{INT_GLYPH[glyph[c.kind]]}</span>
                    </div>
                  )
                })}
              </div>
              {renderRail(items.length, (n) => `Jump to moment ${n}`, `Moments on ${activeSkill}`)}
            </div>
          </>
        )
      }
      case 'reference': {
        const [venue, ...rest] = (item.s || '').split(' · ')
        return (
          <>
            <div className="dlabel">CITATION</div>
            <div className="dcite"><p>{item.t}</p><div className="vv"><span className={`venue ${venue === 'arXiv' ? 'arxiv' : ''}`}>{venue}</span> {rest.join(' · ')}</div></div>
          </>
        )
      }
      default: { /* lecture deck & any file upload */
        // The real document, rendered by the same viewer the module modal uses:
        // PDF inline, images/video inline, Office decks slide-by-slide. Its
        // page-tag rail is driven by the skill citations on the right.
        if (item.file) {
          return (
            <>
              {/* Just the length. A "PAGE N OF M" reading would be a lie the
                  moment you scroll — the embedded PDF is cross-origin, so it
                  never tells us where you actually are. */}
              <div className="dlabel">PREVIEW{item.pages ? <> · {item.pages} PAGES</> : null}</div>
              <div className="pwrap">
                <div className="dview">
                  <MaterialBody
                    url={item.file.url}
                    fileName={item.file.name}
                    fileSize={item.file.size}
                    itemId={item.file.id}
                    pageCount={item.pages}
                    initialPage={item.file.page}
                    targetPage={anchor ?? undefined}
                    /* docked = just the scrolling document; full-screen brings
                       the viewer's own toolbar (page nav, zoom, search) back. */
                    chromeless={!full}
                  />
                </div>
                {/* The prototype's own citation rail (MaterialBody's built-in one
                    is left off): the pages a mapped skill is cited on. */}
                {renderRail(item.pages ?? 0, (p) => `Jump to page ${p}`, `Pages citing ${activeSkill}`)}
              </div>
            </>
          )
        }
        // A video or link lives at an external URL — there was never an upload,
        // so the empty state below would report a problem that doesn't exist.
        // The check owns the column when there is one; otherwise say plainly
        // that there is nothing to render rather than leaving it blank.
        if (item.k === 'video' || item.k === 'link') {
          if (checkInMain) return null
          return (
            <div className="dnofile">
              <span className="glyph" aria-hidden>↗</span>
              <p>Nothing to preview here</p>
              <div className="dfoot">this {item.k} opens in a new tab — the action is on the right.</div>
            </div>
          )
        }
        // Nothing uploaded behind the card. A blank page mock with a format
        // ribbon would imply a document exists, so this is a plain empty state
        // saying what's missing and (for the professor) where to fix it.
        return (
          <div className="dnofile">
            <span className="glyph" aria-hidden>⃞</span>
            <p>No file uploaded yet</p>
            {/* A student can't upload the file, so the professor's instruction is
                an action they have no way to take — tell them what to expect
                instead. */}
            <div className="dfoot">
              {audience === 'stu'
                ? 'your professor hasn’t added it yet — it will show up here once they do.'
                : 'add one from the module page and it will render here.'}
            </div>
          </div>
        )
      }
    }
  }

  /* RIGHT rail skills — quiz/lecture skills anchor to questions/pages */
  const renderSkills = () => {
    /* An Athena note has no professor skill mapping by design — an empty
       SKILLS block would read as something missing rather than not-applicable. */
    if (item.k === 'athena') return null
    const total = (item.skills?.length || 0) + (item.more || 0)
    if (!total) return (<><div className="dlabel">SKILLS</div><div className="dempty">No skills mapped to this {kindLabel} yet.</div></>)
    // Only skills that actually land somewhere are clickable — a page the
    // extraction cited, or a question carrying that tag. The rest have nowhere
    // to jump, so they stay plain text rather than dead buttons.
    const unit = item.file ? 'pages' : item.k === 'session' || item.k === 'live' ? 'moments' : 'questions'
    const anyAnchored = (item.skills || []).some(([n]) => citedUnits(n).length > 0)
    return (
      <>
        <div className="dlabel">SKILLS · {total}</div>
        {anyAnchored ? <div className="dempty" style={{ marginBottom: 8 }}>click a skill to jump to the {unit} that cover it</div> : null}
        {(item.skills || []).map(([n, t]) => {
          const refs = conceptRefs?.[normalizeTopicKey(n)]
          const pages = citedUnits(n)
          const anchored = pages.length > 0
          const off = t === 'none' /* no signal → inactive: no hue, no label */
          return (
            <div key={n} className={`dskill${activeSkill === n ? ' act' : ''}`}>
              <span
                className={`skrow${anchored ? ' anch' : ''}`}
                role={anchored ? 'button' : undefined}
                tabIndex={anchored ? 0 : undefined}
                aria-pressed={anchored ? activeSkill === n : undefined}
                onClick={anchored ? () => toggleSkill(n, pages) : undefined}
                onKeyDown={anchored ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSkill(n, pages) } } : undefined}
              >
                {n}
                {off ? null : <em style={{ color: TIER[t] }}>{t.toUpperCase()}</em>}
              </span>
              {crossRefs(refs, item.t).map(({ verb, titles, extra }) => (
                <span key={verb} className="dref">
                  {verb}{' '}
                  {titles.map((title, i) => (
                    <span key={title}>
                      {i > 0 ? ', ' : ''}
                      {navigable?.has(title)
                        ? <b role="button" tabIndex={0} onClick={() => onNavigate(title)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(title) } }}>{title}</b>
                        : <b className="as-text">{title}</b>}
                    </span>
                  ))}
                  {extra > 0 ? <span className="xmore"> +{extra} more</span> : null}
                </span>
              ))}
              {/* Student view only, and only where they're actually struggling —
                  the same weak-or-shaky rule the old roadmap uses. */}
              {aiTutorHref && (t === 'weak' || t === 'shaky') ? (
                <a
                  className="dstudy"
                  href={`${aiTutorHref}?athena-topic=${encodeURIComponent(n)}`}
                  onClick={(e) => {
                    /* Let a modifier-click do what it says on any link. Without this
                       cmd-click was swallowed into a plain open, while middle-click
                       (auxclick, which React's onClick never sees) opened a tab
                       anyway — the same gesture family behaving two ways. */
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                    if (applySamePageLink(e.currentTarget.href)) e.preventDefault()
                  }}
                  /* Several of these can sit in one rail — without the skill name
                     they are identical links to a screen reader (WCAG 2.4.4). The
                     visible text leads so it stays a substring of the accessible
                     name (WCAG 2.5.3, Label in Name — voice control). */
                  aria-label={`Study with Athena: ${n}`}
                >✦ Study with Athena</a>
              ) : null}
            </div>
          )
        })}
        {item.more ? <div className="dempty">+ {item.more} more tracked skills</div> : null}
      </>
    )
  }

  return (
    <div className={`dcard${full ? ' full' : ''}`} role="dialog" aria-modal="true" aria-label={item.t} ref={cardRef}>
      <div className={`dhead${item.file ? ' two-btn' : ''}`} style={cvar}>
        <span className="dkind"><i />{kindLabel}</span>
        <h2>{item.t}</h2>
        {/* Only a file-backed node gains anything from the extra room (and the
            viewer's own toolbar), so it's the only kind that offers this. */}
        {item.file ? (
          <button
            type="button"
            className="dfs"
            aria-label={full ? 'Exit full screen' : 'Full screen'}
            title={full ? 'Exit full screen' : 'Full screen'}
            onClick={() => setFull((f) => !f)}
          >
            {full ? '⤡' : '⤢'}
          </button>
        ) : null}
        <button type="button" className="dx" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="dbody" style={cvar}>
        {/* A file fills its column edge-to-edge (the viewer owns its own chrome);
            every other kind keeps the padded, scrolling panel. */}
        {/* A file and a quiz both fill the column and scroll INSIDE it, so the
            citation rail beside them stays a fixed-height minimap. */}
        <div className={`dmain${item.file ? ' dfile' : RAILED_KINDS.has(item.k) ? ' dquiz' : ''}`}>
          {renderMain()}
          {/* The check sits UNDER the node's own content, in the wide column —
              the right rail is for status, summary, actions and skills. */}
          {checkOffered && nodeCheck ? (
            <div className="ncblock"><NodeCheckPanel {...nodeCheck} check={check} selfCheck={selfCheck} /></div>
          ) : null}
        </div>
        <aside className="dside">
          {/* Omitted entirely for statusless supplementary material — there is no
              derived coverage to report, and a placeholder chip would be a claim. */}
          {st ? (<><div className="dlabel">STATUS</div>
          <span className={`dchip ${chipCls}`.trim()}><i />{st.label}</span></>) : null}
          {item.ctx ? <button type="button" className="dcrumb" title="opens the module in production">in <b>{item.ctx}</b></button> : null}
          {/* Hidden-from-students, in WORDS. The faded card + eye-off is the glance
              version; on its own it left the state announced only by a 13px glyph,
              and an unshared in-class upload is the one state where a professor
              silently believing they shared is the failure. */}
          {item.hidden ? (
            <><div className="dlabel">VISIBILITY</div>
            <div className="dsum">Students can’t see this yet.</div></>
          ) : null}
          {/* P21, professor only (the adapter never sets it for a student). Its own
              line rather than the SUMMARY: an assignment suppresses SUMMARY to
              avoid double-rendering its description, so this was the one node
              state with nowhere at all to appear. */}
          {item.openUntouched ? (
            <><div className="dlabel">CLASS PROGRESS</div>
            <div className="dsum">No one has started this yet.</div></>
          ) : null}
          {/* Assignments already show their description on the LEFT, so a summary
              here would double-render (same rule as the module modal). */}
          {item.sum && item.k !== 'assignment' ? (<><div className="dlabel">SUMMARY</div><div className="dsum">{item.sum}</div></>) : null}
          {/* For most kinds the CTA is a prototype stub ("opens in production").
              Video and link only reach this modal because the student can tick
              them, so for those the jump has to actually work — as does the
              download on a file-backed node. */}
          {cta ? (
            <>
              <div className="dlabel">ACTIONS</div>
              <button
                type="button"
                className="dopen"
                onClick={
                  item.href
                    ? (item.k === 'session' || item.k === 'live'
                      /* A room is not material — no engagement event for it. */
                      ? () => openAppPath(item.href!)
                      : () => { logMaterial('link_clicked'); openExternal(item.href!) })
                    : item.file
                      ? () => { logMaterial('downloaded'); downloadFile(item.file!.url, item.file!.name) }
                      : undefined
                }
              >
                {cta.label}<span>{cta.glyph}</span>
              </button>
            </>
          ) : null}
          {/* The student's own tick — a claim about effort, never a grade.
              CAVEAT: check-offs are stored under the same `module_item:{id}` key
              the journey overlay reads, and journey-state.ts still treats
              checkedOff as an override to 'mastered'. So this currently DOES
              reach the professor's class lens as mastery, which §11 decision 7
              says it should not. Pre-existing (the old roadmap writes the same
              key); untangle it when that roadmap retires in slice 3. */}
          {showTick && selfCheck ? (
            <>
              {cta ? null : <div className="dlabel">ACTIONS</div>}
              <button
                type="button"
                className="dopen ghost"
                aria-label={selfCheck.checked ? 'Done — press to undo' : 'Mark as done'}
                disabled={selfCheck.saving}
                onClick={selfCheck.onToggle}
              >
                {selfCheck.checked ? 'Undo' : 'Mark as done'}
                <span>{selfCheck.saving ? '…' : selfCheck.checked ? '✓' : '○'}</span>
              </button>
              <div className="dfoot">counts toward your progress, never your marks. Your instructor can see it.</div>
            </>
          ) : null}
          {nodeCheckReview ? <NodeCheckReviewPanel {...nodeCheckReview} /> : null}
          {/* Athena's note: the one node the student may remove — it's hers, not
              the professor's. No confirm dialog: nothing is destroyed — the note
              parks in the Archive tray (bottom edge), where restore and a real
              delete both live. */}
          {item.k === 'athena' && item.artifact && onArchiveArtifact ? (
            <>
              {cta ? null : <div className="dlabel">ACTIONS</div>}
              <button
                type="button"
                className="dopen ghost"
                disabled={removing}
                onClick={async () => {
                  setRemoving(true)
                  const res = await onArchiveArtifact(item.artifact!.id, true)
                  /* "Not found" = already gone (another tab beat us) — the goal
                     state, so treat it as success rather than a red toast. */
                  if (res?.error && res.error !== 'Not found') {
                    toast.error('Couldn’t archive it — try again.')
                    setRemoving(false)
                  } else {
                    /* The modal closing is an absence, not a receipt — say it. */
                    toast.success(`Moved “${item.t}” to the Archive.`)
                    onClose()
                  }
                }}
              >
                {removing ? 'Archiving…' : 'Move to Archive'}<span>✕</span>
              </button>
              <div className="dfoot">It leaves your map but stays in the Archive at the bottom edge — restore or delete it from there.</div>
            </>
          ) : null}
          {/* Every node the professor opens can leave the map from here — the
              one action that belongs to every kind, so it sits at the FOOT of
              ACTIONS rather than competing with the node's own CTA. No confirm:
              nothing is destroyed, the placement is untouched, and the receipt
              carries the way back (see the canvas' archiveNode). */}
          {onArchiveNode && item.key ? (
            /* Set apart from the node's own CTA on purpose. This is the one action
               in the rail that changes what the whole class can see, and it used
               to wear the Athena note's styling — an action whose blast radius is
               one student's own note. Same no-confirm decision (nothing is
               destroyed and the way back is exact), but the consequence is stated
               ABOVE the button rather than in a footnote under it, and the glyph
               is a tray rather than an ✕ that reads as delete. */
            <>
              <div className="dlabel dsep">OFF THE MAP</div>
              {/* Says "roadmap", not "map", on purpose. Archiving removes the node
                  from both roadmaps and nothing else: an archived deck is still
                  listed on the student's Modules page and its bytes still serve.
                  The old wording ("your map and your students'") read as "students
                  can no longer get at this", so a professor archiving a premature
                  deck to keep it from students would have been wrong. */}
              <div className="dsum">Hides it from your roadmap and your students’ roadmap, and parks it in the Archive. It stays available on Modules. Put it back and it returns to this exact spot.</div>
              <button
                type="button"
                className="dopen ghost darch"
                onClick={() => { onArchiveNode(item.key!, item.t); onClose() }}
              >
                Move to Archive<span>🗃</span>
              </button>
            </>
          ) : null}
          {item.k === 'session' && !item.sched ? <div className="dfoot">this room has ended — what opens is its write-up, not the room.</div> : null}
          {renderSkills()}
        </aside>
      </div>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════
   F · THE CANVAS — React Flow + overlays (tools, off-map bench)
   ════════════════════════════════════════════════════════════════ */
/* useNodesInitialized (and any React Flow store hook) needs a provider ancestor,
   so the exported component wraps the canvas in one. */
/* How long the tracked-skills nudge stays before it fades out and unmounts.
   The hold is sized to read three lines of marginalia without hurrying; the
   fade is slow on purpose — a quick blink-out reads as a bug, a long dissolve
   reads as the note retiring. FADE must stay in step with `.tsnote.out`'s
   transition in roadmap-prototype.css §16. */
const NUDGE_HOLD_MS = 9000
const NUDGE_FADE_MS = 2200

/* Stable empties for the pre-entrance frames — fresh [] every render would
   churn React Flow's controlled-props diffing. */
const NO_NODES: Node[] = []
const NO_EDGES: Edge[] = []

/* camera tween duration honouring prefers-reduced-motion — 0 lands the camera
   in the same place, it just cuts instead of gliding. A whole-canvas pan+zoom
   is the page's most vestibularly provocative motion, so unlike the CSS
   micro-animations this one MUST consult the media query. SSR-guarded. */
const tweenMs = (ms: number) =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms

/** Sticky-note byline — "Prof. A. Pandey" from the section professor's name. */
function noteByline(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Professor'
  if (parts.length === 1) return `Prof. ${parts[0]}`
  return `Prof. ${parts[0][0]}. ${parts[parts.length - 1]}`
}

interface RoadmapPrototypeProps {
  moduleTitles?: string[]
  moduleWeeks?: (number | null)[]
  professorName?: string
  /** Annotation/emphasis wording set + edit affordances (off-map bench).
   *  Derived from the AUTHENTICATED role at the mount site — professor page
   *  passes 'prof', student page 'stu'. */
  audience?: 'prof' | 'stu'
  /** A coverage read failed or hit a row cap, so the percentages are partial.
   *  Surfaced beside the headline — see CoverageSignals.degraded. */
  coverageDegraded?: boolean
  /** The student's own overall mastery % — the same direct skill-score
   *  roll-up the professor's roster reads (buildStudentMastery), so both
   *  roles read the same figure for the same student. Professor views read
   *  the class roll-up / lens student from `journeys` instead. null/absent →
   *  the mastery mark and its tally entry stay off the map. */
  myMasteryPct?: number | null
  /** Live roadmap data mapped to the prototype shape; falls back to the demo CS584 content. */
  course?: CourseModule[]
  /** Professor-authored breaks BETWEEN modules — `index` = how many module bands
   *  sit above the line. In-module dividers ride along on `course[i].dividers`. */
  moduleDividers?: { index: number; title: string }[]
  /** Course activities (quizzes/assignments) with no module placement. Professor
   *  only: they wait as loose cards near the today-line, draggable onto a week
   *  (§22). The student page passes none — unplaced work isn't theirs to see. */
  unplaced?: Resource[]
  /** Band gap the today-line sits in (from the calendar — see PrototypeData).
   *  null/absent → the canvas falls back to the end of delivered teaching. */
  todayIndex?: number | null
  /** Node keys the professor has archived (`settings.roadmapArchived`). They are
   *  stripped from the map — for BOTH audiences — and wait in the Archive tray,
   *  where only the professor can put one back. */
  archivedKeys?: string[]
  /** Off-map bench — hidden "Quiz Uploads" module files. */
  quizUploads?: Resource[]
  /** Off-map bench — "Classroom Uploads" module files. */
  classroomUploads?: Resource[]
  /** Triage-engine output at the "everything" detail level (all signals). When
   *  omitted, the demo set for `audience` is shown (so the component still renders
   *  standalone in dev with the demo course). */
  annotations?: RoadmapAnnotation[]
  emphasis?: EmphasisSpec[]
  /** Same signals at the curated "focused" level (the anti-clutter budget). The
   *  settings popover toggles between the two; defaults to "everything". */
  annotationsFocused?: RoadmapAnnotation[]
  emphasisFocused?: EmphasisSpec[]
  /** Class lens (professor only): the section to lazy-load student journeys
   *  for. Omitted (student page / standalone demo) → no lens chrome renders. */
  sectionId?: string
  /** Journeys preloaded by the page when the section has graded activity;
   *  null → the dock lazy-loads on first open. */
  initialJourneys?: StudentJourneysData | null
  /** Student-only: persist this student's "I went through it" tick on a piece of
   *  supplementary material (§14.1). The student page passes its own bound
   *  server action, so the professor bundle never pulls in student actions.
   *  Absent → no tick control renders. */
  onSelfCheck?: (nodeKey: string, next: boolean) => Promise<{ success?: boolean; error?: string }>
  /** Student-only: load this item's generated check (§14). Absent → tick only. */
  onLoadNodeCheck?: (moduleItemId: string) => Promise<{ data?: NodeCheckView; error?: string }>
  /** Student-only: of these module items, which still have their questions being
   *  written. One cheap indexed read — the watcher's alternative was refreshing
   *  the whole page every few seconds (see `useBakeWatch`). */
  onPollBaking?: (itemIds: string[]) => Promise<{ data?: string[]; error?: string }>
  /** Student-only: grade a submission server-side. */
  onSubmitNodeCheck?: (
    moduleItemId: string,
    answers: (number | null)[],
  ) => Promise<{ data?: { passed: boolean; correct: number; total: number }; error?: string }>
  /** Student-only: the course path Athena's `?athena-topic=` deep link hangs off.
   *  Passed only when the section has the feature enabled; absent (professor
   *  view, feature off) → no study links.
   *  A plain string, not a builder — this crosses a server/client boundary. */
  aiTutorHref?: string
  /** Professor-only: read one student's completed check (§14.2), read-only. */
  onLoadStudentNodeCheck?: (
    moduleItemId: string,
    studentId: string,
  ) => Promise<{ data?: NodeCheckReviewView | null; error?: string }>
  /** A quiz node's real questions, fetched when its modal opens. Role-scoped by
   *  the caller: the professor's action reads any quiz in their section, the
   *  student's only a PUBLISHED one. */
  onLoadQuizQuestions?: (quizId: string) => Promise<{ data?: RoadmapDrawerQuestion[]; error?: string }>
  /** An assignment node's real brief, fetched when its modal opens. One action
   *  serves both roles — it authorises the section either way. */
  onLoadAssignmentContent?: (assignmentId: string) => Promise<{ data?: RoadmapDrawerAssignment; error?: string }>
  /** A live-session node's real polls / pop-quizzes. Same shared action. */
  onLoadSessionContent?: (roomId: string) => Promise<{ data?: RoadmapDrawerSession; error?: string }>
  /** Per-skill cross-refs (taught in · assessed by), by normalised skill name —
   *  built server-side by buildConceptRefs. */
  conceptRefs?: Record<string, ConceptRefs>
  /** Concept analytics for the drawer's "By skill" tab (page-loaded). */
  concepts?: ConceptAnalyticsData | null
  /** Tracked skills (professor only): the curation modal's setup data +
   *  unconfirmed-AI-skills badge + the roadmap structure its concept-detail
   *  layer resolves "taught in" from. All three present → the tools cluster
   *  gains the Tracked skills pebble. */
  topicSetup?: TrackedSkillsSetup
  unconfirmedTopicCount?: number
  roadmapData?: AutoRoadmapData
  /** Student-only: this student's Athena-made study artifacts, drawn as margin
   *  notes in their own lane right of the materials column (§15). Absent
   *  (professor view) → the lane doesn't exist. */
  athenaArtifacts?: AthenaArtifactView[]
  /** Student-only: persist interaction state on one of their artifacts. */
  onSaveArtifactState?: (artifactId: string, state: ArtifactState) => Promise<{ success?: true; error?: string }>
  /** Student-only: park an artifact in the Archive tray (true) or put it back
   *  on the map (false). The card's "remove" is an archive, never a delete. */
  onArchiveArtifact?: (artifactId: string, archived: boolean) => Promise<{ success?: true; error?: string }>
  /** Student-only: permanently delete one of their artifacts — offered ONLY
   *  from inside the Archive tray. */
  onDeleteArtifact?: (artifactId: string) => Promise<{ success?: true; error?: string }>
}

export function RoadmapPrototype(props: RoadmapPrototypeProps) {
  return (
    <ReactFlowProvider>
      <RoadmapCanvas {...props} />
    </ReactFlowProvider>
  )
}

/* One parked note in the student's Archive tray. Restore puts it straight back
   in Athena's lane; Delete is the app's ONLY destructive path for an artifact,
   so it arms on the first press and only fires on the second — an inline
   confirm that costs no dialog. The confirm must not outlive the interaction
   that started it: it disarms on mouse-leave, blur, and a short timer (touch
   and keyboard get no mouseleave). Closing the tray disarms too — the CALLER
   keys this card on the tray's open state, so a close/reopen remounts it
   fresh (the bin is hidden, never unmounted — an armed Delete surviving a
   close/reopen is a landmine). */
const DELETE_ARM_MS = 4000
function ArchivedNoteCard({ a, onArchive, onDelete }: {
  a: AthenaArtifactView
  onArchive?: (artifactId: string, archived: boolean) => Promise<{ success?: true; error?: string }>
  onDelete?: (artifactId: string) => Promise<{ success?: true; error?: string }>
}) {
  const [busy, setBusy] = useState<'restore' | 'delete' | null>(null)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), DELETE_ARM_MS)
    return () => clearTimeout(t)
  }, [armed])
  const meta = ARTIFACT_KIND_META[a.kind]
  return (
    <div className="arch-card">
      <div className="athx-k">✦ {meta.label} · from Athena</div>
      <div className="arch-t" title={a.title}>{a.title}</div>
      <div className="arch-acts">
        {onArchive ? (
          <button
            type="button"
            className="arch-btn"
            disabled={busy !== null}
            aria-label={`Put “${a.title}” back on your map`}
            onClick={async () => {
              setBusy('restore')
              const res = await onArchive(a.id, false)
              if (res?.error === 'Not found') {
                /* Gone entirely (deleted in another tab) — nothing to restore,
                   and "try again" would be a lie. The refresh clears the card. */
                toast.info('That note is gone — nothing left to restore.')
              } else if (res?.error) {
                toast.error('Couldn’t restore it — try again.')
                setBusy(null)
              } else {
                /* success unmounts the card via the revalidated artifact list */
                toast.success(`“${a.title}” is back on your map.`)
              }
            }}
          >
            {busy === 'restore' ? 'Restoring…' : 'Put back on map'}
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            className={`arch-btn danger${armed ? ' armed' : ''}`}
            disabled={busy !== null}
            aria-label={armed ? `Press again to delete “${a.title}” for good` : `Delete “${a.title}” for good`}
            onMouseLeave={() => { if (!busy) setArmed(false) }}
            onBlur={() => { if (!busy) setArmed(false) }}
            onClick={async () => {
              if (!armed) { setArmed(true); return }
              setBusy('delete')
              const res = await onDelete(a.id)
              /* "Not found" = already gone (another tab beat us) — goal state. */
              if (res?.error && res.error !== 'Not found') {
                toast.error('Couldn’t delete it — try again.')
                setBusy(null)
                setArmed(false)
              } else {
                toast.success(`Deleted “${a.title}” — it’s gone for good.`)
              }
            }}
          >
            {busy === 'delete' ? 'Deleting…' : armed ? 'Delete for good?' : 'Delete'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/* stable empties for the lens-on state (fresh arrays would re-trigger the memos) */
const NO_ANNOTATIONS: RoadmapAnnotation[] = []
const NO_EMPHASIS: EmphasisSpec[] = []
/* stable identity — computeLayout is memoised on its inputs */
const NO_MODULE_DIVIDERS: { index: number; title: string }[] = []
const NO_ARTIFACT_MAP: Map<number, AthenaArtifactView[]> = new Map()
const NO_LOOSE: Resource[] = []
const NO_ARCHIVED_KEYS: string[] = []

/** Stamped on the history entry a node card pushes, so only that entry is ever popped. */
const CARD_HISTORY_MARKER = { roadmapCard: true } as const

/** Is the entry we are standing on one a node card pushed? */
function isOwnHistoryEntry(): boolean {
  return (window.history.state as { roadmapCard?: boolean } | null)?.roadmapCard === true
}

function RoadmapCanvas({ moduleTitles = [], moduleWeeks = [], professorName = '', course: courseIn = COURSE, moduleDividers = NO_MODULE_DIVIDERS, unplaced = UNPLACED, todayIndex = null, archivedKeys = NO_ARCHIVED_KEYS, quizUploads = DEMO_QUIZ_UPLOADS, classroomUploads = [], audience = 'prof', coverageDegraded = false, myMasteryPct = null, annotations, emphasis, annotationsFocused, emphasisFocused, sectionId, initialJourneys = null, concepts = null, topicSetup, unconfirmedTopicCount = 0, roadmapData, aiTutorHref, onSelfCheck, onLoadNodeCheck, onPollBaking, onSubmitNodeCheck, onLoadStudentNodeCheck, onLoadQuizQuestions, onLoadAssignmentContent, onLoadSessionContent, conceptRefs, athenaArtifacts, onSaveArtifactState, onArchiveArtifact, onDeleteArtifact }: RoadmapPrototypeProps) {
  /* ── the Archive: what the professor has taken off the map ────────────────
     Stripped out HERE, once, so the layout, the edges, the progress roll-up and
     the annotation targets all see the same map the professor sees. `pending`
     holds the optimistic answer for a write still in flight, keyed by node key,
     so the card leaves (or comes back) on the click rather than on the
     round-trip. */
  const [pendingArchive, setPendingArchive] = useState<Readonly<Record<string, boolean>>>({})
  const archivedSet = useMemo(() => {
    const keys = new Set(archivedKeys)
    for (const [k, on] of Object.entries(pendingArchive)) {
      if (on) keys.add(k)
      else keys.delete(k)
    }
    return keys
  }, [archivedKeys, pendingArchive])
  const unplacedOn = audience === 'prof' && !!sectionId
  /* Cards dropped on a week this session, by resource key → band index. They are
     rendered into that week's column straight away and the write runs behind it;
     `placedIds` (the same keys) is what takes them out of the loose pile. The two
     are set and cleared together — a card must never be in both places, or in
     neither. */
  const [pendingPlaced, setPendingPlaced] = useState<PendingPlacement>({})
  const [placedIds, setPlacedIds] = useState<ReadonlySet<string>>(() => new Set())
  const loose = useMemo(
    () => (unplacedOn ? unplaced.filter((r) => r.key && !placedIds.has(r.key) && !archivedSet.has(r.key)) : NO_LOOSE),
    [unplacedOn, unplaced, placedIds, archivedSet],
  )
  /* node id → resource key: the drag writes positions by key (placing one card
     re-indexes the node ids, a key never moves). */
  const looseKeyById = useMemo(() => {
    const m = new Map<string, string>()
    loose.forEach((r, j) => { if (r.key) m.set(`u${j}`, r.key) })
    return m
  }, [loose])
  const course = useMemo(
    () => withPendingPlacements(stripArchived(courseIn, archivedSet), unplaced, pendingPlaced),
    [courseIn, archivedSet, unplaced, pendingPlaced],
  )
  const archivedNodes = useMemo(
    () => collectArchived(courseIn, unplaced, archivedSet, moduleTitles),
    [courseIn, unplaced, archivedSet, moduleTitles],
  )

  /* ── class lens (professor only): whole class by default; picking a student
     repaints the map with their journey via JourneyOverlayContext ── */
  const lensEnabled = audience === 'prof' && !!sectionId
  const [journeys, setJourneys] = useState<StudentJourneysData | null>(initialJourneys)
  const [journeysLoading, setJourneysLoading] = useState(false)
  const [lensStudentId, setLensStudentId] = useState<string | null>(null)
  /* one bottom panel at a time: the analytics roster or the tracked-skills drawer */
  const [panel, setPanel] = useState<'analytics' | 'skills' | null>(null)
  /* the Tracked-skills button's review badge — fed live by the drawer
     (realtime AI-skill inserts bump it; closing the drawer re-derives it) */
  const [skillsBadge, setSkillsBadge] = useState(unconfirmedTopicCount)
  /* the tracked-skills note is a NUDGE, not a task the professor owes us: it
     greets them on arrival, fades, and leaves the DOM — the shining pebble
     stays as the standing cue. Deliberately NOT persisted: a fresh visit
     nudges again, which is the point (a dismissal we remembered forever would
     silently bury the one prompt that explains the shine). */
  const [nudge, setNudge] = useState<'on' | 'out' | 'gone'>('on')
  useEffect(() => {
    const fade = setTimeout(() => setNudge('out'), NUDGE_HOLD_MS)
    const drop = setTimeout(() => setNudge('gone'), NUDGE_HOLD_MS + NUDGE_FADE_MS)
    return () => { clearTimeout(fade); clearTimeout(drop) }
  }, [])
  const journeysRef = useRef<{ has: boolean; busy: boolean }>({ has: !!initialJourneys, busy: false })
  const ensureJourneys = useCallback(async () => {
    if (journeysRef.current.has || journeysRef.current.busy || !sectionId) return
    journeysRef.current.busy = true
    setJourneysLoading(true)
    const res = await getStudentJourneys(sectionId)
    journeysRef.current.busy = false
    setJourneysLoading(false)
    if (res.error || !res.data) {
      toast.error(res.error || 'Could not load student journeys')
      return
    }
    journeysRef.current.has = true
    setJourneys(res.data)
  }, [sectionId])
  /* stable handlers — the lens dock and the two drawers are memo()'d, and the
     canvas re-renders constantly (React Flow reports node dimensions in bursts
     while the map lays out). Inline arrows here would defeat that entirely. */
  const onEnsureJourneys = useCallback(() => { void ensureJourneys() }, [ensureJourneys])
  const onOpenAnalytics = useCallback(() => { void ensureJourneys(); setPanel('analytics') }, [ensureJourneys])
  const onCloseAnalytics = useCallback(() => setPanel(null), [])
  const onClearLens = useCallback(() => setLensStudentId(null), [])
  const onSkillsOpenChange = useCallback((o: boolean) => setPanel(o ? 'skills' : null), [])

  const lensIndex = lensStudentId ? (journeys?.students.findIndex((s) => s.studentId === lensStudentId) ?? -1) : -1
  const lensStudent = lensIndex >= 0 ? journeys!.students[lensIndex] : null
  const journeyOverlay = lensStudent?.nodes ?? null
  const lensOn = !!lensStudent

  /* annotation detail level: "everything" (default, all signals) vs "focused" (the
     curated anti-clutter set). Toggled from the settings popover. */
  const [annotDetail, setAnnotDetail] = useState<'all' | 'focused'>('all')
  const focused = annotDetail === 'focused'
  /* The saved detail level can only be read after mount (a lazy initializer would
     desync SSR), so first paint would show the FULL set and snap down to `focused`
     a frame later — a flash that reads as a glitch. Hold the layer for that one
     frame instead: annotations draw themselves in anyway, so arriving a frame late
     is invisible, while arriving wrong is not. */
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  /* Nothing is drawn on the paper until React Flow has placed the camera:
     pre-init the nodes render at the flow's raw origin and then visibly JUMP
     when resetView lands, with the title only appearing after the snap. So the
     viewport layer is held invisible until this flips (CSS `.cam`, §2) — the
     title then appears exactly where the loading skeleton was already drawing
     it (a hand-off, not a re-entrance) and the nodes rise with their stagger. */
  const [entered, setEntered] = useState(false)
  /* triage-engine output when wired; otherwise the demo set for this audience.
     A student lens replaces the class-aggregate layers entirely — annotations,
     emphasis and the class skill pills (CSS) all rest while it's on; the
     staged entrance holds them back until the map itself has risen. */
  const annotationsResting = lensOn || !prefsLoaded || !entered
  const annotationList = annotationsResting ? NO_ANNOTATIONS : ((focused ? annotationsFocused : annotations) ?? annotations ?? DEMO_ANNOTATIONS[audience])
  const emphasisSpec = annotationsResting ? NO_EMPHASIS : ((focused ? emphasisFocused : emphasis) ?? emphasis ?? DEMO_EMPHASIS[audience])
  const noteAuthor = useMemo(() => noteByline(professorName), [professorName])
  const [open, setOpen] = useState<boolean[]>(() => course.map(() => true))
  const [benchOpen, setBenchOpen] = useState(false)
  const [calm, setCalm] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** The settings pebble itself — Escape restores focus here (see the handler). */
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null)

  /* Persist the popover prefs across reloads. Hydrate AFTER mount (not a lazy
     initializer) so the server-rendered defaults and first client render match —
     then write on change. Keyed by audience so prof/student can differ. */
  useEffect(() => {
    const d = localStorage.getItem(`roadmap.${audience}.annotDetail`)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate-after-mount avoids the SSR mismatch a lazy initializer would cause (see use-sidebar-rail.ts)
    if (d === 'all' || d === 'focused') setAnnotDetail(d)
    if (localStorage.getItem(`roadmap.${audience}.calm`) === '1') setCalm(true)
    // Unblocks the annotation layer — set LAST so it can never reveal the
    // pre-hydration default (see prefsLoaded).
    setPrefsLoaded(true)
  }, [audience])
  useEffect(() => { localStorage.setItem(`roadmap.${audience}.annotDetail`, annotDetail) }, [audience, annotDetail])
  useEffect(() => { localStorage.setItem(`roadmap.${audience}.calm`, calm ? '1' : '0') }, [audience, calm])
  /* pan-&-zoom mode: off = wheel scrolls the map (default); on = wheel zooms
     under the cursor and dragging pans (Figma/Miro canvas convention) */
  const [panZoom, setPanZoom] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  /* real (measured) node heights, keyed by id — filled as React Flow reports
     dimensions via onNodesChange, then folded back into the layout so every
     inter-node gap is exactly COL_GAP (the estimates only get us close). */
  const [measured, setMeasured] = useState<Map<string, number>>(() => new Map())
  /* after the first paint settles, let node positions glide, so expand/collapse
     reflows the map smoothly instead of snapping every node to a new spot */
  const [glide, setGlide] = useState(false)
  /* node detail ("dream cloud"): the focused node + the item its card shows.
     `closing` drives the exit animation before the overlay unmounts. */
  const [detail, setDetail] = useState<{ item: DetailItem; nodeId: string } | null>(null)
  const [closing, setClosing] = useState(false)
  /* Optimistic overrides for the student's own check-offs, keyed by node key.
     The cards and the percentages come from the server, so a confirmed toggle
     calls router.refresh(); this only keeps the open modal honest until then. */
  const [selfChecked, setSelfChecked] = useState<Record<string, boolean>>({})
  const [selfSaving, setSelfSaving] = useState<string | null>(null)
  const [pendingRefresh, startRefresh] = useTransition()
  const prevViewport = useRef<{ x: number; y: number; zoom: number } | null>(null)
  /* The camera as it stood before the dossier card slid the map aside — read on
     close to undo the lens' zoom step (the shift is inverted from the framing
     centre instead, so a reader who scrolled keeps their place). While the lens
     is on, `lensPinX` replaces w/2 as the spine pin's anchor, so default mode's
     anti-drift pin recentres in the free area instead of cancelling the lens
     tween; it is re-derived whenever the canvas changes width. */
  const lensViewport = useRef<Viewport | null>(null)
  const lensPinX = useRef<number | null>(null)
  /* true while a programmatic camera tween is in flight (snap-back, lens
     shift), so the spine pin in onMove lets it animate instead of yanking x
     to its anchor on the first frame. Declared here — above every effect
     that reads it — for the compiler's use-before-modify analysis. */
  const settling = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rf = useReactFlow()
  const router = useRouter()
  const flowRef = useRef<HTMLDivElement>(null)
  /* Last ?node= value this component itself wrote, so the popstate listener can
     tell a Back/Forward from an echo of one of our own writes. */
  const nodeParam = useRef<string | null>(null)
  /* Whether the open card owns a pushed history entry to pop on close. */

  /* demo emphasis rides on the course data itself (em/emTone per node) —
     wording set follows the authenticated audience, not a toggle */
  /* Which nodes' questions THIS session is waiting on — see `withMyBaking`. Keyed
     by module-item id, seeded only by the open panel's own report, because the
     server's own record of it is course-level and cannot say who asked. */
  const [myBaking, setMyBaking] = useState<Readonly<Record<string, true>>>(NO_MY_BAKING)
  const emCourse = useMemo(
    () => withMyBaking(applyDemoEmphasis(course, emphasisSpec), myBaking),
    [course, emphasisSpec, myBaking],
  )
  /* A node whose questions are being written says so in the map's own hand — a
     margin note with an arrow into the card, the same object the map uses for
     everything else it has to tell you. Synthesised here rather than coming from
     the triage engine because it is transient and belongs to ONE student's click,
     where the engine's annotations are standing class-level judgements.
     Gated by `annotationsResting` like every other annotation, so it can't draw
     itself over the entrance or under the professor's student lens. */
  const bakingNotes = useMemo<RoadmapAnnotation[]>(() => {
    if (annotationsResting) return NO_ANNOTATIONS
    return emCourse.flatMap((m) =>
      m.materials
        .filter((r) => r.baking)
        .map((r) => ({
          v: 'margin' as const,
          sub: 'ink' as const,
          tone: 'info' as const,
          /* By id, not title. A generated note nobody proof-reads must not be
             able to land on the wrong card, and titles overlap in real courses
             ("Attention" inside "Attention Is All You Need"). `r.key` is present
             on every material card; the filter above already required `baking`,
             which only `withMyBaking` sets, and only on a keyed card. */
          t: `item:${parseNodeKey(r.key ?? '').id}`,
          text: 'writing you <b>a few questions</b> on this…',
        })),
    )
  }, [emCourse, annotationsResting])
  /* What the loose cards ARE, said the way the map says everything else: one
     margin note with an arrow into the first of them. It was briefly part of the
     today-line's own label, which was wrong twice over — the line is the
     calendar's statement about the term, not a caption for whatever happens to be
     parked under it, and an instruction set in the divider's voice can't point at
     anything. Anchored by node key, not title (see the baking note). */
  const looseNote = useMemo<RoadmapAnnotation[]>(() => {
    const first = loose[0]
    if (annotationsResting || !first?.key) return NO_ANNOTATIONS
    return [{
      v: 'margin', sub: 'ink', tone: 'warn',
      t: `item:${parseNodeKey(first.key).id}`,
      text: loose.length === 1
        ? 'this one has <b>no week yet</b> — drag it onto any week'
        /* When the pile is capped, the note must say so. Otherwise the cap reads
           as "that's all of them" and the remaining items are simply invisible —
           worse than the unbounded scatter it replaces, because at least that was
           honest. Placing one frees a slot, so the next appears here. */
        : loose.length > UNPLACED_ON_MAP_MAX
          ? `<b>${UNPLACED_ON_MAP_MAX}</b> of <b>${loose.length}</b> with no week yet — drag one onto any week and the next appears`
          : `these <b>${loose.length}</b> have no week yet — drag one onto any week`,
    }]
  }, [loose, annotationsResting])
  /* Only the LAYER gets them: `annotationList` also feeds the roof-headroom pass,
     and a margin note claims no headroom (it sits beside the card, not above it). */
  const drawnAnnotations = useMemo(() => {
    const merged =
      bakingNotes.length || looseNote.length
        ? [...annotationList, ...bakingNotes, ...looseNote]
        : annotationList
    /* Deduped because this is a MERGE of independent sources, and AnnotationLayer
       builds one DOM node per entry with no identity of its own — so the same note
       arriving from more than one side drew twice at identical coordinates. They
       overlay perfectly, so it never looked wrong; the cost is a node screen readers
       announce twice and an invisible copy sitting on top of a visible one for
       hit-testing. Keyed on everything that decides what is drawn and where, so two
       genuinely different notes on one target still both survive. */
    const seen = new Set<string>()
    return merged.filter((a) => {
      const id = [a.v, a.t, a.sub ?? '', a.tone, a.text ?? '', a.href ?? '', a.t2 ?? ''].join('\u0000')
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }, [annotationList, bakingNotes, looseNote])
  /* overall completion roll-up — the old page-top bar, redrawn low-fi in
     the canvas language above the first module */
  const progress = useMemo(() => progressOf(course), [course])
  /* the one mastery figure the station shows, per viewer: the professor reads
     the class roll-up — or the lens student's own once one is overlaid — and a
     student always reads their own. null = no mastery signal yet (nothing
     graded) → the mark and its tally entry simply stay off the map. */
  const mastery = useMemo(() => {
    const mk = (pct: number, label: string) => ({ pct, label, color: TIER[masteryTier(pct)] })
    if (audience === 'stu') return myMasteryPct != null ? mk(myMasteryPct, 'your mastery') : null
    if (lensStudent) return lensStudent.masteryPct != null ? mk(lensStudent.masteryPct, `${lensStudent.name.split(' ')[0]}’s mastery`) : null
    const pct = journeys?.classStats.classMastery
    return pct != null ? mk(pct, 'class mastery') : null
  }, [audience, myMasteryPct, lensStudent, journeys])
  /* where the mastery mark lands on the delivery bar. Mastery is measured
     only over material DELIVERED so far, so its mark is scaled to the bar's
     filled extent (done + in-progress), never to the whole course: pct% of
     what's been taught, drawn as pct% OF the ink. At full mastery the mark
     reaches exactly the ink's edge, not the bar's end. */
  const masteryX = mastery
    ? ((progress.done + progress.prog) / Math.max(progress.total, 1)) * mastery.pct
    : 0
  /* the page title's description — the whole-course-at-a-glance promise, in
     each audience's own terms. One source (HEADER_DESC) with the off-canvas
     states, so the words never change mid-load. */
  const headerDesc = HEADER_DESC[audience]
  /* Which cards need roof headroom: a flag is planted above its node, and only
     the 'tab' variant tucks under the edge instead. Titles are the same keys the
     annotation layer resolves against ('session:'/'module:' prefixes stripped —
     a module band already has MOD_GAP above it). */
  const roofFlagged = useMemo(() => {
    const out = new Set<string>()
    for (const a of annotationList) {
      if (a.v !== 'flag' || a.sub === 'tab' || a.t.startsWith('module:')) continue
      out.add(a.t.replace(/^session:/, ''))
    }
    return out
  }, [annotationList])
  /* Athena's artifacts, grouped under the band (module index) they anchor to.
     An artifact whose module is no longer rendered simply drops off the map —
     NOT into the Archive tray (that holds only notes the student parked) — and
     comes back if the module is republished. Oldest first, so a new note
     lands at the bottom of its flock. Archived notes never reach the lane —
     they live in the Archive tray below until restored or deleted. */
  const artifactsByModule = useMemo(() => {
    if (!athenaArtifacts?.length) return NO_ARTIFACT_MAP
    const idxById = new Map<string, number>()
    course.forEach((m, i) => { if (m.id) idxById.set(m.id, i) })
    const map = new Map<number, AthenaArtifactView[]>()
    for (const a of athenaArtifacts) {
      if (a.archivedAt) continue
      const i = idxById.get(a.moduleId)
      if (i === undefined) continue
      const list = map.get(i) ?? []
      list.push(a)
      map.set(i, list)
    }
    for (const list of map.values()) list.sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    return map
  }, [athenaArtifacts, course])
  /* The Archive tray's contents — newest parking first. Student-only by
     construction (professors never receive athenaArtifacts). */
  const archivedArtifacts = useMemo(
    () => (athenaArtifacts ?? []).filter((a) => a.archivedAt)
      .sort((x, y) => (y.archivedAt ?? '').localeCompare(x.archivedAt ?? '')),
    [athenaArtifacts],
  )
  /* Container width, tracked by the re-anchor ResizeObserver below — the
     lane's x is derived from it so the peek is the same on every screen. */
  const [containerW, setContainerW] = useState(0)
  /* Where Athena's lane sits for THIS container: wide screens push it right so
     only ATH_PEEK px of a note crosses the frame at the spine pose — the lane
     never rides fully into the default view, whatever the window size. */
  const looseStacked = looseStackedFor(containerW)
  const athX = useMemo(
    () => (containerW ? athXFor(containerW, fitZoom(containerW)) : ATH_X_MIN),
    [containerW],
  )
  /* ── Knowledge-path lens, part 1: what the URL names (issue #94) ──────────
     ?path=<artifactId> lights a saved knowledge_map artifact on the map. The
     row is the single source of truth — the id rides the URL (ids-in-URL
     rule, §14.4), so the lens survives refresh and reopens from the note. */
  const kpParam = useSearchParams().get('path')
  const kpArtifact = useMemo(() => {
    if (!kpParam || audience !== 'stu') return null
    return (athenaArtifacts ?? []).find((a) => a.id === kpParam && a.kind === 'knowledge_map') ?? null
  }, [kpParam, audience, athenaArtifacts])
  /* Modules the lens needs visible — a DERIVED overlay on the reader's own
     open flags, never written back into them: their expand/collapse choices
     survive the lens closing. Locked weeks stay locked; the map never lies
     about access. An empty set doubles as "this path's material left the
     course" (the dead-param check below), so that skip is one guard. */
  const kpOpenIdx = useMemo(() => {
    const out = new Set<number>()
    if (!kpArtifact) return out
    const km = kpArtifact.payload as KnowledgeMapPayload
    const keys = new Set([...(km.stops ?? []).map((s) => s.nodeKey), km.focus?.nodeKey])
    course.forEach((m, i) => {
      if (m.locked || m.draft) return
      if (m.materials.some((r) => r.key && keys.has(r.key))) out.add(i)
    })
    return out
  }, [kpArtifact, course])
  const shownOpen = useMemo(
    () => (kpOpenIdx.size ? open.map((o, i) => o || kpOpenIdx.has(i)) : open),
    [open, kpOpenIdx],
  )
  /* ── unplaced work, waiting on the map (professor only) ──
     The bench used to hold these where nobody looks. They now wait near the
     today-line as ordinary cards, and a drag onto a module plants them (the
     same placement edge the quiz/assignment dialogs write). `unplacedPos` holds
     the spots the professor has dragged them to this session — deliberately NOT
     persisted: an unplaced card's position carries no meaning to store, and a
     reload puts it back at today.
     Placed ids drop out immediately so the card leaves the loose pile the
     moment the write lands, rather than after the refresh round-trip. */
  const [unplacedPos, setUnplacedPos] = useState<Record<string, XYPosition>>({})
  /* The drag in flight: which card, the module whose column has caught it
     (-1 = none), that column's side, and the card's height (the gap that column
     has to open).
     The card's live POSITION is not in here — it lives in `unplacedPos`, written
     from the position changes React Flow reports. That is not optional: in a
     controlled flow (`nodes` + `onNodesChange`), React Flow's drag never writes to
     its own store — `triggerNodeChanges` only reports — so a card moves exactly as
     far as the app puts it. Skip those changes and it freezes under a cursor that
     keeps going. What must NOT happen on top of that is a second answer for the
     same position (the old snap-to-slot override): the drag then alternated between
     the pointer and the slot every frame, which is what read as lag. */
  const [unplacedDrag, setUnplacedDrag] = useState<{ id: string; moduleIdx: number; side: 'L' | 'R'; h: number; kind: Kind } | null>(null)
  /* The line's own words. Locale-formatted on the CLIENT (the server renders in
     UTC — see the triage engine's note on "today"), so the date always reads as
     the professor's own. */
  const [todayDate, setTodayDate] = useState('')
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate-after-mount, like the prefs read above: a lazy initializer would render the SERVER's date (UTC "today", off by a day for half the world) and mismatch on hydrate
    setTodayDate(new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  }, [])
  const todayLabel = useMemo(() => (todayDate ? `today · ${todayDate}` : ''), [todayDate])
  /* The place the target column is holding open. Derived rather than passed
     straight through so the layout memo only re-runs when the ANSWER changes —
     which module, which column, how much room — never on plain pointer motion. */
  const dropSlot = useMemo(
    () => (unplacedDrag && unplacedDrag.moduleIdx >= 0
      ? { moduleIdx: unplacedDrag.moduleIdx, side: unplacedDrag.side, h: unplacedDrag.h, kind: unplacedDrag.kind }
      : null),
    [unplacedDrag],
  )
  const { nodes, height: contentHeight } = useMemo(
    () => computeLayout(emCourse, shownOpen, calm, moduleTitles, moduleWeeks, noteAuthor, measured, moduleDividers, roofFlagged, artifactsByModule, athX, loose, todayLabel, unplacedOn, todayIndex, dropSlot, looseStacked),
    [emCourse, shownOpen, calm, moduleTitles, moduleWeeks, noteAuthor, measured, moduleDividers, roofFlagged, artifactsByModule, athX, loose, todayLabel, unplacedOn, todayIndex, dropSlot, looseStacked],
  )
  /* Count what is actually ON the map — a collapsed module hides its notes
     (computeLayout renders open bands only), so both the affordance's number
     and the lane's very existence must follow `open`, or one module click
     leaves the edge advertising notes that snap to empty paper. */
  const athenaCount = useMemo(() => {
    let n = 0
    for (const [i, list] of artifactsByModule) {
      if (shownOpen[i] && !course[i]?.locked) n += list.length
    }
    return n
  }, [artifactsByModule, shownOpen, course])
  const hasAthenaLane = athenaCount > 0
  /* Two-pose camera bookkeeping: the pending settle timer, and which pose the
     camera is parked on — poses only move via the edge affordance now, so this
     is simply "which anchor the onMove pin holds x to". */
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [atLanePose, setAtLanePose] = useState(false)
  /* ── Knowledge-path lens, part 2: the stops on the map ────────────────────
     (part 1 — the URL, the artifact row and the derived open overlay — sits
     above computeLayout, which its nodes depend on.)
     Stops resolved to on-map boxes, in payload order (foundational → focus).
     Anything not currently rendered is dropped from the ink, never guessed at. */
  const kpath = useMemo(() => {
    if (!kpArtifact) return null
    const km = kpArtifact.payload as KnowledgeMapPayload
    const hitFor = (key: string | undefined): { id: string; box: KpBox } | null => {
      if (!key) return null
      for (const n of nodes) {
        if (n.type !== 'resource') continue
        const r = (n.data as unknown as ResourceData).r
        if (r.key !== key) continue
        const w = typeof n.style?.width === 'number' ? n.style.width : RES_W
        return { id: n.id, box: { x: n.position.x, y: n.position.y, w, h: measured.get(n.id) ?? resHeight(r, calm) } }
      }
      return null
    }
    const stops = (km.stops ?? []).map((s, i) => ({ title: s.title, masteryPct: s.masteryPct, n: i + 1, hit: hitFor(s.nodeKey) }))
    const focus = { title: km.focus?.title ?? '', hit: hitFor(km.focus?.nodeKey) }
    const litIds = new Set<string>([...stops, focus].flatMap((s) => (s.hit ? [s.hit.id] : [])))
    /* The "start here" stop and which side its note hangs on — decided HERE so
       the camera framing and the ink layer can't disagree about either. The
       weakest MEASURED stop wins; with no mastery signal anywhere the path's
       first stop is where to start by definition. */
    const hit = stops.filter((s) => s.hit)
    const weakest = hit.reduce<(typeof hit)[number] | null>(
      (best, s) => (s.masteryPct == null ? best : best?.masteryPct == null || s.masteryPct < best.masteryPct ? s : best),
      null,
    ) ?? hit[0] ?? null
    const noteSide: 'l' | 'r' = weakest && weakest.hit && weakest.hit.box.x >= RIGHT_X ? 'r' : 'l'
    return { stops, focus, litIds, weakestN: weakest?.n ?? null, noteSide }
  }, [kpArtifact, nodes, measured, calm])
  const kpOn = !!kpath && kpath.litIds.size > 0
  /* Every rendered card box — what the channel router must route around. The
     spine (a 4px full-height ribbon) and dividers (map-wide rules) are not
     cards: including them would wall off every corridor. */
  const kpObstacles = useMemo<KpBox[]>(() => {
    if (!kpArtifact) return []
    const out: KpBox[] = []
    for (const n of nodes) {
      if (n.type === 'spine' || n.type === 'divider') continue
      const w = typeof n.style?.width === 'number' ? n.style.width : RES_W
      out.push({ x: n.position.x, y: n.position.y, w, h: measured.get(n.id) ?? n.measured?.height ?? 100 })
    }
    return out
  }, [kpArtifact, nodes, measured])
  /* Closing = stripping the param; everything else (camera, classes, ink)
     derives from its absence. replaceState, not push — the lens is a mirror
     of the URL, and Back should leave the roadmap, not replay the lens. */
  const closeKpath = useCallback(() => {
    const params = new URLSearchParams(window.location.search)
    if (!params.has('path')) return
    params.delete('path')
    const qs = params.toString()
    window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname)
  }, [])
  /* A ?path= nothing answers to — a deleted note, another section's link, a
     path whose material left the course. Same voice as nodeLinkMissed, once
     per offending value. */
  const kpMissedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!kpParam || audience !== 'stu') { kpMissedFor.current = null; return }
    if ((kpArtifact && kpOpenIdx.size > 0) || kpMissedFor.current === kpParam) return
    kpMissedFor.current = kpParam
    closeKpath()
    toast('Couldn’t find that path on your roadmap')
  }, [kpParam, audience, kpArtifact, kpOpenIdx, closeKpath])
  /* Camera: frame the whole path on enter, restore the exact viewport on
     close — the ✕'s "back to where you were" promise. Same settling guard and
     lensPinX handoff as the dossier lens, so the spine pin neither cancels
     the tween nor yanks the frame back on the first scroll. */
  const kpFramed = useRef(false)
  const kpathRef = useRef(kpath)
  useEffect(() => { kpathRef.current = kpath })
  /* Frame the INK, not just the cards: the margin note reaches ~260px past
     its stop and the tag ~40px above the focus — fitting node ids alone
     cropped the one instructional sentence out of the opening shot (the
     ANNOTATION_REACH lesson: the canvas has to know what lives outside the
     columns to frame the map). Manual viewport math rather than fitBounds,
     because a course-spanning path must not zoom the cards into confetti:
     below the readability floor the frame anchors on the path's START (the
     foundational stop + the start-here note) and the rest is a scroll away. */
  const frameKpath = useCallback((duration: number) => {
    const kp = kpathRef.current
    const flow = flowRef.current
    if (!kp || kp.litIds.size === 0 || !flow) return
    const w = flow.clientWidth, h = flow.clientHeight
    if (!w || !h) return
    const boxes = [
      ...kp.stops.flatMap((s) => (s.hit ? [s.hit.box] : [])),
      ...(kp.focus.hit ? [kp.focus.hit.box] : []),
    ]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const b of boxes) {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
    }
    const pad = kp.noteSide === 'r' ? { l: 70, r: 320 } : { l: 320, r: 70 }
    const rect = { x: minX - pad.l, y: minY - 64, width: maxX - minX + pad.l + pad.r, height: maxY - minY + 128 }
    const zFit = Math.min(w / rect.width, h / rect.height)
    const zoom = Math.min(1, Math.max(zFit, 0.55))
    const x = w / 2 - (rect.x + rect.width / 2) * zoom
    const y = zoom <= zFit + 1e-6
      ? h / 2 - (rect.y + rect.height / 2) * zoom /* whole path fits — centre it */
      : 40 - rect.y * zoom /* too tall at the floor — open on the start */
    /* Pin x SYNCHRONOUSLY — we computed the final x ourselves, and a scroll
       mid-tween hands the camera to the onMove pin (the user-takeover clause
       clears `settling`), which without this yanked the frame back to the
       spine centre: the "jumps right and re-centres during scroll" bug. The
       lens also releases the x translate-extent (like the dossier lens does),
       or d3's constrain force-centres a wide viewport and fights this pin on
       every wheel event. */
    lensPinX.current = x
    settling.current = true
    rf.setViewport({ x, y, zoom }, { duration })
    window.setTimeout(() => { settling.current = false }, duration + 40)
  }, [rf])
  useEffect(() => {
    const flow = flowRef.current
    if (!flow || !entered) return
    if (kpOn) {
      if (kpFramed.current) return /* already framed — a re-layout tick */
      kpFramed.current = true
      /* a frame late: the module open-overlay above may have just put the
         stop nodes on the map this same render */
      const raf = requestAnimationFrame(() => frameKpath(tweenMs(650)))
      return () => cancelAnimationFrame(raf)
    }
    if (kpFramed.current) {
      kpFramed.current = false
      lensPinX.current = null
      /* Deferred a frame like the entry framing (also what keeps the pose
         write out of the effect body). "Back to your map" = the load pose,
         deterministically — resetView's own math (spine centred, top of map,
         fit zoom). Restoring a snapshot of the arrival viewport proved
         fragile: captured mid-arrival it held a camera the reader never
         actually saw, and the only way out was a reload. */
      const raf = requestAnimationFrame(() => {
        setAtLanePose(false)
        const w = flow.clientWidth || 900
        const zoom = fitZoom(w)
        settling.current = true
        const ms = tweenMs(450)
        rf.setViewport({ x: w / 2, y: TOP_ALLOWANCE * zoom, zoom }, { duration: ms })
        setTimeout(() => { settling.current = false }, ms + 40)
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [kpOn, entered, rf, frameKpath])
  /* A resize while the lens is on would leave lensPinX holding the x computed
     for the old width, with the onMove pin actively parking the map there —
     the exact stale-pin bug the dossier lens's re-anchor effect documents.
     Re-frame on the lane-tracker's width signal instead. */
  const kpFramedW = useRef(0)
  useEffect(() => {
    if (!kpOn || !kpFramed.current) { kpFramedW.current = containerW; return }
    if (kpFramedW.current === containerW) return
    kpFramedW.current = containerW
    frameKpath(tweenMs(220))
  }, [containerW, kpOn, frameKpath])
  /* Focus follows the lens: ✕ takes it on entry (which is also how Escape is
     discovered), and the canvas takes it back on close so a keyboard student
     isn't dumped at the top of the document. */
  const kpCloseRef = useRef<HTMLButtonElement>(null)
  const kpWasOn = useRef(false)
  useEffect(() => {
    if (kpOn && !kpWasOn.current) { kpWasOn.current = true; kpCloseRef.current?.focus() }
    else if (!kpOn && kpWasOn.current) { kpWasOn.current = false; flowRef.current?.focus() }
  }, [kpOn])
  /* Escape closes the lens — on document like every other Escape handler in
     this file (bubbling order matters for the layer contract), and only when
     no node card is open above it (the card's own close owns that press). */
  useEffect(() => {
    if (!kpOn || detail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      closeKpath()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [kpOn, detail, closeKpath])

  /* light the focused node (React Flow puts the className on its .react-flow__node
     wrapper); everything else dims via the .d-open container class. The
     knowledge-path stops carry their glow the same way (kp-lit / kp-focus);
     an open card wins over the path on its own node. */
  const displayNodes = useMemo(() => {
    let out = nodes
    if (kpOn && kpath) {
      out = out.map((n) => {
        if (!kpath.litIds.has(n.id)) return n
        return { ...n, className: kpath.focus.hit?.id === n.id ? 'kp-lit kp-focus' : 'kp-lit' }
      })
    }
    if (detail) out = out.map((n) => (n.id === detail.nodeId ? { ...n, className: 'dfocus' } : n))
    /* An unplaced card the professor dragged somewhere this session keeps that
       spot. The card in flight keeps the position it had when this render was
       triggered — NOT a fresh one per pointermove: React Flow owns the movement
       between renders (it mutates its own nodeLookup), and every `nodes` array we
       hand it resets that from the prop. Carrying the live position here is what
       lets the card keep following the cursor across a re-render instead of
       snapping back to where the drag began. The module about to take it lights up. */
    if (unplacedOn && (Object.keys(unplacedPos).length > 0 || unplacedDrag)) {
      const hotId = unplacedDrag && unplacedDrag.moduleIdx >= 0 ? `m${unplacedDrag.moduleIdx}` : null
      out = out.map((n) => {
        if (n.type === 'unplaced') {
          const key = (n.data as unknown as UnplacedData).r.key
          const pos = key ? unplacedPos[key] : undefined
          if (pos) n = { ...n, position: pos }
        }
        if (n.id === hotId) n = { ...n, className: `${n.className ? `${n.className} ` : ''}snap-hot` }
        return n
      })
    }
    return out
  }, [nodes, detail, kpOn, kpath, unplacedOn, unplacedPos, unplacedDrag])
  /* stable across calm / measured re-layout — only changes when a module opens
     or closes, so the connectors never flash */
  const edges = useMemo(
    () => computeEdges(course, shownOpen, artifactsByModule, unplacedDrag),
    [course, shownOpen, artifactsByModule, unplacedDrag],
  )

  /* ── placing an unplaced card ─────────────────────────────────────────────
     Each week's band as one rect: the module card plus everything laid out in
     its lanes. This is the target a drag is actually aiming at. */
  const bands = useMemo(() => {
    const out = new Map<number, { top: number; bottom: number }>()
    for (const n of nodes) {
      const mm = /^m(\d+)(?:-|$)/.exec(n.id)
      if (!mm) continue
      const mi = Number(mm[1])
      const top = n.position.y
      const bottom = top + (measured.get(n.id) ?? n.measured?.height ?? 0)
      const cur = out.get(mi)
      out.set(mi, cur ? { top: Math.min(cur.top, top), bottom: Math.max(cur.bottom, bottom) } : { top, bottom })
    }
    return out
  }, [nodes, measured])

  /** The week whose band holds this point, or -1. */
  const moduleUnder = useCallback((cx: number, cy: number): number => {
    if (Math.abs(cx) > CATCH_X) return -1
    let best = -1, bestD = Infinity
    for (const [mi, band] of bands) {
      if (!course[mi] || course[mi].draft) continue
      const dy = cy < band.top ? band.top - cy : cy > band.bottom ? cy - band.bottom : 0
      if (dy > CATCH_Y || dy >= bestD) continue
      bestD = dy
      best = mi
    }
    return best
  }, [bands, course])

  const onNodeDrag = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    if (node.type !== 'unplaced') return
    const d = node.data as unknown as UnplacedData
    const h = measured.get(node.id) ?? node.measured?.height ?? resHeight(d.r, calm)
    const mi = moduleUnder(node.position.x + RES_W / 2, node.position.y + h / 2)
    /* The ONE thing that changes the map mid-drag is WHICH module is offering to
       take the card. Everything else — the card tracking the cursor — is React
       Flow's own business, and it is the only thing happening 60 times a second.
       Pushing that through React state (a fresh `nodes` array → setNodes over
       every node on the map → a re-render of the whole pane) is what made the
       drag crawl, so the guard below is load-bearing, not an optimisation. */
    setUnplacedDrag((prev) => (!prev || prev.id !== node.id || prev.moduleIdx === mi
      ? prev
      : { ...prev, moduleIdx: mi }))
  }, [measured, calm, moduleUnder])

  const onNodeDragStart = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    if (node.type !== 'unplaced') return
    const d = node.data as unknown as UnplacedData
    setUnplacedDrag({
      id: node.id, moduleIdx: -1, side: d.side, kind: d.r.k,
      h: measured.get(node.id) ?? node.measured?.height ?? resHeight(d.r, calm),
    })
  }, [measured, calm])

  const onNodeDragStop = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    if (node.type !== 'unplaced') return
    setUnplacedDrag(null)
    const d = node.data as unknown as UnplacedData
    const key = d.r.key
    const h = measured.get(node.id) ?? node.measured?.height ?? resHeight(d.r, calm)
    const mi = moduleUnder(node.position.x + RES_W / 2, node.position.y + h / 2)
    const moduleId = mi >= 0 ? course[mi]?.id : undefined
    /* Dropped clear of every module: it stays unplaced, just parked where the
       professor left it (this session only — see unplacedPos). */
    if (!key || mi < 0 || !moduleId || !sectionId) {
      if (key) setUnplacedPos((p) => ({ ...p, [key]: node.position }))
      return
    }
    const [kind, resourceId] = key.split(':')
    if ((kind !== 'quiz' && kind !== 'assignment') || !resourceId) return
    const where = moduleTitles[mi] ?? course[mi]?.title ?? 'that module'
    /* Optimistic, both halves: the card leaves the loose pile AND lands in that
       week's column on the drop, before the write is sent. The professor's next
       move is looking at where it went — making them watch a round-trip and a
       refetch first is the drag feeling slow for a second time. `router.refresh()`
       still runs, but only to reconcile: by the time it lands the map already
       shows the answer, and withPendingPlacements is a no-op once the real course
       carries the card.
       On failure both halves are undone together, so the card is back among the
       loose ones at the today-line — where it was — and the error says why. */
    setPlacedIds((prev) => new Set(prev).add(key))
    setPendingPlaced((prev) => ({ ...prev, [key]: mi }))
    const putBack = (why: string) => {
      setPlacedIds((prev) => { const next = new Set(prev); next.delete(key); return next })
      setPendingPlaced((prev) => { const next = { ...prev }; delete next[key]; return next })
      toast.error(`Couldn’t put “${d.r.t}” on ${where} — it’s back at today. ${why}`)
    }
    void setResourcePlacement(sectionId, kind, resourceId, moduleId)
      .then((res) => {
        if (res.error) { putBack(res.error); return }
        toast.success(`“${d.r.t}” is on ${where} now.`)
        router.refresh()
      })
      /* A REJECTED action, not a returned error: the actions in this codebase
         never throw, but the fetch under them can (offline, tab suspended, server
         restart mid-request). Without this the card keeps a place it was never
         given — the one failure the optimistic path must not have. */
      .catch(() => putBack('Check your connection and try again.'))
  }, [measured, calm, moduleUnder, course, moduleTitles, sectionId, router])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    /* Unplaced cards are the only draggable nodes, and this flow is controlled —
       so React Flow reports their movement here and moves nothing itself. Applying
       these IS the drag. Keyed by resource key, not node id: placing one card
       re-indexes the rest. Cheap by construction — one entry in a small record,
       and computeLayout doesn't depend on it, so the map is not re-laid-out per
       pointermove; only the one node's position changes. */
    for (const c of changes) {
      if (c.type !== 'position' || !c.position || !c.id.startsWith('u')) continue
      const key = looseKeyById.get(c.id)
      if (key) setUnplacedPos((p) => ({ ...p, [key]: c.position as XYPosition }))
    }
    const dims = changes.filter((c): c is Extract<NodeChange, { type: 'dimensions' }> => c.type === 'dimensions' && !!c.dimensions)
    if (dims.length === 0) return
    setMeasured((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const c of dims) {
        const h = c.dimensions?.height
        if (h != null && next.get(c.id) !== h) { next.set(c.id, h); changed = true }
      }
      return changed ? next : prev
    })
  }, [looseKeyById])

  /* ── taking a node off the map, and putting it back ───────────────────────
     Nothing is deleted and no placement is touched (archive-actions.ts), so the
     way back is exact — which is why the receipt carries the undo chip rather
     than a confirm dialog carrying a warning. Optimistic in both directions: on
     failure the pending answer is dropped so the map falls back to the server's. */
  const archiveOn = audience === 'prof' && !!sectionId
  const clearPending = useCallback((key: string) => {
    setPendingArchive((p) => {
      if (!(key in p)) return p
      const next = { ...p }
      delete next[key]
      return next
    })
  }, [])
  const restoreNode = useCallback((key: string, title: string) => {
    if (!sectionId) return
    setPendingArchive((p) => ({ ...p, [key]: false }))
    void setRoadmapNodeArchived(sectionId, key, false).then((res) => {
      if (res.error) {
        clearPending(key)
        toast.error(res.error)
        return
      }
      toast.success(`“${title}” is back on the map.`)
      router.refresh()
    })
  }, [sectionId, router, clearPending])
  const archiveNode = useCallback((key: string, title: string) => {
    if (!sectionId) return
    setPendingArchive((p) => ({ ...p, [key]: true }))
    void setRoadmapNodeArchived(sectionId, key, true).then((res) => {
      if (res.error) {
        clearPending(key)
        toast.error(res.error)
        return
      }
      toast.success(`Moved “${title}” to the Archive.`, {
        /* Longer than the default 4s: the click closes a full-height drawer,
           re-flows the map and fires a refresh, so the professor's attention is
           necessarily elsewhere while the only one-click way back is ticking. */
        duration: 8000,
        action: { label: 'Undo', onClick: () => restoreNode(key, title) },
      })
      router.refresh()
    })
  }, [sectionId, router, clearPending, restoreNode])

  const draftRowRef = useRef<HTMLDivElement>(null)
  const classroomRowRef = useRef<HTMLDivElement>(null)

  /* dream-cloud anchoring: slide the React Flow viewport so the focused node lands
     centered in the strip LEFT of the detail card, at a calm 0.7 zoom (the analog
     of the prototype's map-slide-and-shrink, done through the viewport instead). */
  const anchorCloud = useCallback((nodeId: string) => {
    const flow = flowRef.current
    const n = rf.getNode(nodeId)
    if (!flow || !n) return
    const hh = n.measured?.height ?? 100
    const cy = n.position.y + hh / 2
    const W = flow.clientWidth, H = flow.clientHeight
    const panelW = Math.min(1120, W * 0.74)
    const dcardLeft = W - W * 0.015 - panelW
    const stripCenterX = Math.max(90, dcardLeft / 2)
    const Z = 0.7
    /* Start from the SPINE centred in the strip — the weeks are what the strip
       is for — then shift ONLY as far as the clicked node itself demands: if
       the highlighted card would land under the drawer (right column, Athena's
       far-right lane) or off the left edge (quizzes/assignments), slide the
       framing the minimum that brings it fully into the strip. The spine gives
       way exactly when the two can't both fit — a dimmed map whose one lit
       node is off screen reads as breakage, not de-emphasis. */
    let x = stripCenterX
    const nw = n.measured?.width ?? (typeof n.style?.width === 'number' ? n.style.width : 320)
    const margin = 14
    const nodeL = x + n.position.x * Z
    const nodeR = nodeL + nw * Z
    if (nodeR > dcardLeft - margin) x -= nodeR - (dcardLeft - margin)
    else if (nodeL < margin) x += margin - nodeL
    rf.setViewport({ x, y: H / 2 - cy * Z, zoom: Z }, { duration: tweenMs(600) })
  }, [rf])

  /* dossier anchoring — the lens-card analog of anchorCloud: while the card
     claims the left strip, slide the viewport so what was mid-screen recentres
     in the REMAINING width and step the zoom down a notch, so the card covers
     paper rather than weeks. Runs on lens ON/OFF only — walking the roster
     with ‹ › keeps the camera still. The `settling` guard is load-bearing:
     without it the default mode's spine pin (onMove) cancels this tween on
     its first frame and the whole move silently never happens. */
  useEffect(() => {
    const flow = flowRef.current
    if (!flow) return
    if (lensOn) {
      if (lensViewport.current) return /* already shifted (e.g. roster walk) */
      const vp = rf.getViewport()
      lensViewport.current = vp
      const framed = lensFraming(vp, flow.clientWidth, flow.clientHeight)
      lensPinX.current = framed.x
      settling.current = true
      const ms = tweenMs(450)
      rf.setViewport(framed, { duration: ms })
      setTimeout(() => { settling.current = false }, ms + 40)
    } else if (lensViewport.current) {
      const prev = lensViewport.current
      lensViewport.current = null
      lensPinX.current = null
      /* UNDO THE LENS' FRAMING — KEEP THE READER'S PLACE.
         Two different things happen to the camera while the card is open: the
         LENS shifts x into the strip the card covers and steps the zoom down
         0.85, and the READER scrolls wherever they like (the map stays live
         under the card, unlike the frozen node-modal view). Closing must undo
         the first and preserve the second.
         This used to be an either/or: any real gesture set a `moved` flag and
         then the close restored NOTHING — so after a single scroll the map
         stayed parked off-centre at the reduced zoom, with no gesture left in
         default mode to recover x. That is the "sometimes it doesn't come back"
         report.
         So invert the framing instead of restoring a snapshot (unlensFraming —
         its round-trip identity with lensFraming is unit-tested): take the flow
         point now at the FREE area's centre, undo the zoom RATIO so any zoom the
         reader added survives, and put that point back at the canvas centre.
         With no gesture in between this is algebraically identical to
         setViewport(prev) — the untouched case still lands exactly where it
         always did. */
      const restored = unlensFraming(
        prev, rf.getViewport(), flow.clientWidth, flow.clientHeight, panZoom,
      )
      settling.current = true
      const ms = tweenMs(450)
      rf.setViewport(restored, { duration: ms })
      setTimeout(() => { settling.current = false }, ms + 40)
    }
  }, [lensOn, panZoom, rf])

  /* Mirror the open card into ?node=<key> — the same param the classic view uses,
     so a link to a node opens its card on whichever roadmap the reader lands on.
     History contract (also the classic view's): a fresh open PUSHES one entry, so
     browser Back closes the card instead of leaving the roadmap; moving between
     nodes inside the card REPLACES, so entries don't pile up; closing pops the
     pushed entry rather than leaving it behind as a dead Forward.

     Written through the History API, not router.replace: the URL here is a mirror
     of client state, and this page's RSC payload is heavy enough that refetching
     it on every card open would be a real cost for nothing. */
  const writeNodeParam = useCallback((key: string | null, pop = false) => {
    if (key === nodeParam.current) return
    const fresh = key !== null && nodeParam.current === null
    nodeParam.current = key
    /* Pop only from an actual close. A keyless node opening OVER an addressable
       one clears the param too, but its card is still up — popping there would
       spend the entry that open card still owns. */
    /* Pop only when the CURRENT history entry is the one this card pushed (#588).
       A ref answered "did we ever push?", but the question is "is the entry we are standing
       on still ours?", which a ref cannot know. Whenever it went stale (a
       manual Back, a deep-linked open over an earlier card, a pop whose early-return below
       skipped the reset) this `history.back()` spent an entry the card did not own and
       navigated the reader clean out of the roadmap. That is the intermittent "Escape goes
       back" report: Escape closes the card, and closing was the thing navigating.

       The marker rides on history.state, which the browser swaps for us as we move, so it
       cannot drift the way a ref does. */
    if (key === null && pop && isOwnHistoryEntry()) { window.history.back(); return }
    const params = new URLSearchParams(window.location.search)
    if (key) params.set('node', key)
    else params.delete('node')
    const qs = params.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    if (fresh) window.history.pushState(CARD_HISTORY_MARKER, '', url)
    else window.history.replaceState(null, '', url)
  }, [])

  /* A ?node= key nothing on the map answers to: a deleted quiz, an item sitting
     on the off-map bench, a node from another section, a collapsed module. Say so
     rather than leaving the reader on a bare roadmap wondering what the link was
     meant to show — and hand the key back, so the next card they open still gets
     a history entry of its own. */
  const nodeLinkMissed = useCallback(() => {
    writeNodeParam(null)
    /* Deliberately "couldn't find" rather than "isn't there any more": a collapsed
       module hides its materials from this lookup too, so the stronger claim is
       false exactly when Athena names a node the student happens to have folded
       away — and that path is now reachable from the chat dock, not just a link. */
    toast('Couldn’t find that on your roadmap')
  }, [writeNodeParam])

  const openDetail = useCallback((item: DetailItem, nodeId: string) => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setDetail((prev) => {
      if (!prev) prevViewport.current = rf.getViewport() /* remember where to snap back on close */
      return { item, nodeId }
    })
    setClosing(false)
    /* A node with no key (a live tile with no room behind it) can still open —
       it just isn't addressable, so the param is cleared rather than left stale. */
    writeNodeParam(item.key ?? null)
    requestAnimationFrame(() => anchorCloud(nodeId))
  }, [rf, anchorCloud, writeNodeParam])

  const closeDetail = useCallback(() => {
    setClosing(true)
    writeNodeParam(null, true)
    if (prevViewport.current) rf.setViewport(prevViewport.current, { duration: tweenMs(450) })
    /* Drop the remembered viewport with the card: it belongs to the card that was
       open, so a later close with nothing on screen can't tween the camera to a
       spot the reader has long since panned away from. */
    closeTimer.current = setTimeout(() => {
      setDetail(null); setClosing(false); prevViewport.current = null; closeTimer.current = null
    }, 560)
  }, [rf, writeNodeParam])

  /* The student's self check-off, for supplementary material only. A lecture,
     quiz or session is derived from what actually happened, so it is never the
     student's to tick — `st === ''` is precisely the adapter's marker for
     "stateless extra", which keeps this rule in one place. */
  const selfCheckFor = useCallback((item: DetailItem) => {
    const nodeKey = item.key
    if (!onSelfCheck || !nodeKey || !EXTRA_KINDS.has(item.k)) return undefined
    const card = course.flatMap((m) => m.materials).find((r) => r.key === nodeKey)
    if (!card?.tickable) return undefined
    // Stored under the RAW module_items.id — the id the old roadmap's check-off
    // already writes and the journey overlay matches. Prefixing would fork the
    // same fact into two entries, one per surface.
    const rawId = nodeKey.slice(nodeKey.indexOf(':') + 1)

    const checked = selfChecked[rawId] ?? card.st === 'done'
    return {
      checked,
      saving: selfSaving === rawId || pendingRefresh,
      onToggle: () => {
        const next = !checked
        setSelfSaving(rawId)
        setSelfChecked((prev) => ({ ...prev, [rawId]: next }))
        void (async () => {
          const res = await onSelfCheck(rawId, next)
          setSelfSaving(null)
          if (res?.error) {
            setSelfChecked((prev) => ({ ...prev, [rawId]: !next })) // roll back
            toast.error(res.error)
            return
          }
          // Cards, percentages and the rollup are server-derived. Refetch inside
          // a transition so the button stays "saving" for the WHOLE operation —
          // otherwise it settles first and the numbers change afterwards, which
          // reads as a glitch rather than as the result of the click.
          startRefresh(() => router.refresh())
        })()
      },
    }
  }, [onSelfCheck, course, selfChecked, selfSaving, pendingRefresh, startRefresh, router])

  /* Professor reviewing one student (§14.2): only when the class lens has a
     student selected — without one there is no "whose check" to show. */
  const nodeCheckReviewFor = useCallback((item: DetailItem) => {
    const nodeKey = item.key
    if (!onLoadStudentNodeCheck || !lensStudentId || !nodeKey || !EXTRA_KINDS.has(item.k)) return undefined
    return {
      itemId: nodeKey.slice(nodeKey.indexOf(':') + 1),
      studentId: lensStudentId,
      studentName: journeys?.students.find((s) => s.studentId === lensStudentId)?.name,
      load: onLoadStudentNodeCheck,
    }
  }, [onLoadStudentNodeCheck, lensStudentId, journeys])

  /* Stable so NodeCheckPanel's effect doesn't re-fire every render. */
  const onNodeCheckPassed = useCallback(() => {
    startRefresh(() => router.refresh())
  }, [startRefresh, router])

  /* Opening a node is what STARTS its quick check, and the map's own data was
     rendered before that click — so the node knows nothing about it. This does
     two things with the panel's report: remembers that THIS session is the one
     that asked (`withMyBaking` — the DB column is course-level and cannot say
     so). The report IS the state: no refetch, because refetching would also hand
     the flag to every classmate. Fired on the transition only. */
  const onNodeCheckBaking = useCallback((itemId: string, baking: boolean) => {
    setMyBaking((prev) => {
      if (baking === !!prev[itemId]) return prev
      const next = { ...prev }
      if (baking) next[itemId] = true
      else delete next[itemId]
      return next
    })
  }, [])

  /* ── Watching the nodes whose questions are being written ─────────────────
     The pool job notifies nobody when it lands, so the map has to look again. It
     asks ONE targeted action about the ids it is already showing — deliberately
     NOT `router.refresh()`, which re-runs the roadmap's whole assembly every few
     seconds AND re-mounts the hand-drawn annotation layer, blinking every margin
     note on the map out and back on every tick.
     The watcher's own rules — no standing poll, a tick budget rather than a
     request budget, hidden tabs cost a tick not a request, no stacking, and stop
     CLAIMING it when the budget runs out — live in the hook, where they can be
     tested without mounting this canvas. */
  const bakingIds = useMemo(() => Object.keys(myBaking), [myBaking])
  /* The drawn note is aria-hidden decoration, so this is the ONLY channel for it.
     One region for the whole canvas, mounted always and empty at rest: a live
     region that appears with its text already inside is not a change, so most
     screen readers say nothing. Named nodes, because "on this" means nothing when
     two are waiting.
     Only the START is announced. The map cannot tell "your questions are ready"
     from "we stopped watching" — both clear the same state — and guessing would
     be the kind of claim this whole change exists to stop making. */
  const bakingTitles = useMemo(
    () => emCourse.flatMap((m) => m.materials.filter((r) => r.baking).map((r) => r.t)),
    [emCourse],
  )
  const latestBakingIds = useRef<string[]>(bakingIds)
  useEffect(() => {
    latestBakingIds.current = bakingIds
  }, [bakingIds])
  const [bakePolling, setBakePolling] = useState(false)
  /* The ids are read out of state inside the updater rather than closed over, so
     `onBakeTick` stays stable and the watcher's interval (and its budget) survives
     a node being added or retired mid-flight. */
  const onBakeTick = useCallback(() => {
    if (!onPollBaking) return
    setBakePolling(true)
    void Promise.resolve()
      .then(() => {
        const ids = latestBakingIds.current
        return ids.length === 0 ? null : onPollBaking(ids)
      })
      .then((res) => {
        /* No answer (network, a denied read) → keep waiting. Only a real answer
           may retire a node's state; treating a failure as "done" would take the
           note away while the work is still running. */
        if (!res?.data) return
        const still = new Set(res.data)
        setMyBaking((prev) => {
          const next: Record<string, true> = {}
          for (const id of Object.keys(prev)) if (still.has(id)) next[id] = true
          return Object.keys(next).length === Object.keys(prev).length ? prev : next
        })
      })
      /* The action catches its own errors, but a transport-level RPC failure
         rejects — unhandled, that is a console error on a page that is otherwise
         fine. The watcher stays correct either way: `busy` clears below. */
      .catch(() => {})
      .finally(() => setBakePolling(false))
  }, [onPollBaking])
  /* Budget spent with something still unfinished: stop SAYING it is being
     written. Clearing the timer and leaving the state was the bug — a node that
     shimmers and promises questions for the rest of the session. */
  const onBakeGiveUp = useCallback(() => setMyBaking(NO_MY_BAKING), [])
  useBakeWatch({
    active: bakingIds.length > 0,
    busy: bakePolling,
    onTick: onBakeTick,
    onGiveUp: onBakeGiveUp,
  })

  /* The generated check for a tickable item (§14). Only wired when the page
     supplied the student actions; the panel itself falls back to the plain tick
     whenever the generator judged there was nothing worth asking about. */
  const nodeCheckFor = useCallback((item: DetailItem) => {
    const nodeKey = item.key
    if (!onLoadNodeCheck || !onSubmitNodeCheck || !nodeKey || !EXTRA_KINDS.has(item.k)) return undefined
    return {
      itemId: nodeKey.slice(nodeKey.indexOf(':') + 1),
      load: onLoadNodeCheck,
      submit: onSubmitNodeCheck,
      onPassed: onNodeCheckPassed,
      onBaking: onNodeCheckBaking,
    }
  }, [onLoadNodeCheck, onSubmitNodeCheck, onNodeCheckPassed, onNodeCheckBaking])

  /* The card a node on the canvas opens. In one place because three callers need
     it: a click, a cross-ref jump, and a ?node= deep link. Null = this node has
     no card (a module band, a standalone note). */
  const detailForNode = useCallback((node: Node): DetailItem | null => {
    const mm = /^m(\d+)/.exec(node.id)
    const ci = mm ? Number(mm[1]) : -1
    const ctx = ci >= 0 ? (moduleTitles[ci] ?? course[ci]?.title) : undefined
    if (node.type === 'resource') {
      const r = (node.data as unknown as ResourceData).r
      return r.k === 'note' ? null : { ...r, ctx }
    }
    /* An unplaced card opens the same drawer a placed one does — it is the same
       quiz or assignment, just not on a module yet, so "not on a module" is its
       context line rather than a week's title. */
    if (node.type === 'unplaced') {
      const r = (node.data as unknown as UnplacedData).r
      return { ...r, ctx: 'Not on a module yet' }
    }
    if (node.type === 'session') {
      const s = (node.data as unknown as SessionData).s
      return { k: 'session', t: s.t, s: s.s, key: s.key, href: s.href, sched: s.sched, ints: s.ints, sum: s.sum, ctx }
    }
    if (node.type === 'live') {
      const room = (node.data as unknown as LiveData).room
      return { k: 'live', t: room?.t ?? LIVE.t, key: room?.key, ctx }
    }
    if (node.type === 'athena') {
      const a = (node.data as unknown as AthenaData).a
      return {
        k: 'athena',
        t: a.title,
        key: athenaNodeKey(a.id),
        ctx,
        sum: `${ARTIFACT_KIND_META[a.kind].label} Athena made for you in chat — ${ARTIFACT_KIND_META[a.kind].summary(a.payload, a.state)}.`,
        artifact: a,
      }
    }
    return null
  }, [moduleTitles, course])

  /* cross-ref ("Taught in …" / "Assessed by …") → swap the card to that node in
     place, re-anchoring the cloud. Only nodes currently on the map resolve. */
  const navigateTo = useCallback((title: string) => {
    const found = nodes.find((n) => n.type === 'resource' && (n.data as unknown as ResourceData).r.t === title)
    const item = found ? detailForNode(found) : null
    if (found && item) openDetail(item, found.id)
  }, [nodes, detailForNode, openDetail])

  /* ?node=<key> → the node carrying that key. Only nodes currently rendered
     resolve (a collapsed module hides its materials), so a link to something no
     longer on the map leaves the view alone instead of half-opening a card.
     Returns whether it resolved: callers must not leave `nodeParam` holding a key
     no card is showing, or the next open would read as an in-card jump. */
  const openByKey = useCallback((key: string) => {
    for (const n of nodes) {
      const item = detailForNode(n)
      if (item?.key === key) { openDetail(item, n.id); return true }
    }
    return false
  }, [nodes, detailForNode, openDetail])

  /* Browser Back/Forward: follow the ?node= the history entry carries. Our own
     writes set `nodeParam` first, so the pop they cause lands here as a no-op. */
  useEffect(() => {
    const onPop = () => {
      const key = new URLSearchParams(window.location.search).get('node')
      if (key === nodeParam.current) return
      nodeParam.current = key
      /* An entry naming a node that is no longer on the map has nothing to show,
         so close whatever is open and strip the dead param — leaving the previous
         card up under a URL that claims a different node is the worse lie. */
      if (!key) { closeDetail(); return }
      if (!openByKey(key)) { closeDetail(); nodeLinkMissed() }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [openByKey, closeDetail, nodeLinkMissed])

  /* Athena driving: the chat dock router.push()es `?node=<key>` while this page
     is ALREADY mounted, which fires neither onInit (first load) nor popstate
     (Back/Forward) — only the searchParams hook sees it. The ref starts on the
     initial value so mount stays onInit's job, and an echo of our own history
     writes (Next mirrors pushState/replaceState into useSearchParams) bails on
     the nodeParam check before re-opening anything. */
  const nodeSearchParam = useSearchParams().get('node')
  const appliedNodeParam = useRef(nodeSearchParam)
  /* The pending open, held in a ref rather than closed over by the effect's
     cleanup. openByKey's identity tracks `nodes` → `measured` → `course`, so a
     cleanup-based cancel would drop the open whenever any of those changed inside
     the one frame — and the applied-ref has already moved on, so the re-run
     early-returns and the card silently never appears. Cancelling only when a NEW
     param arrives keeps "Athena says it opened something" honest. */
  const driveFrame = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (driveFrame.current !== undefined) cancelAnimationFrame(driveFrame.current) }, [])
  useEffect(() => {
    if (nodeSearchParam === appliedNodeParam.current) return
    appliedNodeParam.current = nodeSearchParam
    if (nodeSearchParam === nodeParam.current) return
    /* Deferred a frame: the state changes live in a callback (the linter's
       subscribe-pattern shape), and the render this URL change caused has
       settled before the card open tweens the viewport. */
    if (driveFrame.current !== undefined) cancelAnimationFrame(driveFrame.current)
    driveFrame.current = requestAnimationFrame(() => {
      driveFrame.current = undefined
      nodeParam.current = nodeSearchParam
      if (!nodeSearchParam) { closeDetail(); return }
      /* The entry the router pushed carries no CARD_HISTORY_MARKER, so closing will not
         pop it. That is the point: the entry the router pushed is
         Athena's DRIVE, not this card — and a drive usually starts on another
         page, so popping it doesn't close a card, it takes the student off the
         roadmap entirely and back where they came from. Every way of dismissing
         the card reaches `closeDetail`, so the same jump came from Escape, the
         card's own ✕ and a click on the canvas alike, which is why it read as
         "closing Athena reloaded the app and threw me back to the course page".
         Only an entry this component pushed itself is ours to pop; the drive's
         stays for the Back button, which is where undoing a navigation lives. */
      if (!openByKey(nodeSearchParam)) nodeLinkMissed()
    })
  }, [nodeSearchParam, openByKey, closeDetail, nodeLinkMissed])

  /* Which titles navigateTo can actually resolve — the modal renders the rest of
     its cross-refs as plain text rather than buttons that swallow the click. */
  const navigableTitles = useMemo(
    () => new Set(nodes.filter((n) => n.type === 'resource').map((n) => (n.data as unknown as ResourceData).r.t)),
    [nodes],
  )

  /* rebuild the graph whenever expand/collapse, node-style, or titles change.
     Node ids are stable, so module nodes are never remounted (no re-animate);
     only newly-appearing resources animate in. Resource/session/live clicks open
     the detail cloud; notes are standalone; link/video open a new tab. */
  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    if (node.type === 'module') {
      if (detail) { closeDetail(); return }
      const mm = /^m(\d+)/.exec(node.id)
      const ci = mm ? Number(mm[1]) : -1
      // A week that isn't open yet has nothing to expand onto — swallow the click
      // rather than toggling a band that would render empty.
      if (course[ci]?.locked) return
      setOpen((prev) => prev.map((o, j) => (j === ci ? !o : o)))
      /* A collapse can take Athena's whole lane off the map; park the pose
         bookkeeping home then (the one event that can remove the lane) so the
         onMove pin doesn't chase a lane that no longer exists. Only then —
         resetting on EVERY toggle left the camera at the lane with the
         affordance offering to take the reader where they already were. */
      const nextOpen = open.map((o, j) => (j === ci ? !o : o))
      let laneSurvives = false
      for (const [i, list] of artifactsByModule) {
        if (nextOpen[i] && !course[i]?.locked && list.length > 0) { laneSurvives = true; break }
      }
      if (!laneSurvives) setAtLanePose(false)
      return
    }
    // Nodes that jump straight out instead of opening a card. Video and link
    // normally do — but a student who can tick them must get the modal instead:
    // it is the only surface carrying the tick, and without it their percentage
    // counts material they cannot complete. The modal keeps an "Open …" action,
    // so the jump is one extra click.
    if (node.type === 'resource') {
      const r = (node.data as unknown as ResourceData).r
      /* Jumping out is only right when the card has nothing more to say. Two cases
         where it does: a student who can TICK the node (the tick lives only in the
         card), and a professor with a student selected in the lens — that student's
         quick-check review renders inside the card, and only for these very kinds
         (video/image/reference/link), so jumping out made the panel unreachable. */
      if (!r.tickable && !lensOn) {
        if (r.k === 'link') { openExternal(r.href || 'https://' + r.s); return }
        if (r.k === 'video') {
          if (r.href) { openExternal(r.href); return }
          /* No usable URL. This used to fall through to a YouTube SEARCH for the
             item's title — quietly handing the reader a third-party page that may
             have nothing to do with the material. Say what's actually wrong. */
          toast('This video has no link yet')
          return
        }
      }
    }
    if (node.type === 'live') {
      // Join the room in a NEW tab — the roadmap stays put behind it. It's an
      // internal app route (/professor/courses/…/live-classroom/…), so open it
      // directly (not openExternal, which treats its argument as a URL host).
      const room = (node.data as unknown as LiveData).room
      if (room?.href) { window.open(room.href, '_blank', 'noopener'); return }
    }
    const item = detailForNode(node)
    if (item) openDetail(item, node.id)
  }, [detail, detailForNode, openDetail, closeDetail, lensOn, course, open, artifactsByModule])

  const onPaneClick = useCallback(() => { if (detail) closeDetail() }, [detail, closeDetail])

  /* default view: spine (flow x=0) centered, top of the map in view, and zoomed
     so the ANNOTATIONS fit — not just the card columns.
     Cards span ±540, but a margin note hangs ANNOTATION_REACH further out, so at
     zoom 1 a 1440px laptop cropped the right-hand lane and lost most of the
     triage output unless the reader found Pan & zoom and dragged. Capped at 1:
     this only ever zooms OUT to fit, never magnifies a wide screen. */
  /* Floored at 0.8. Unclamped this is a pure function of width — ~0.81 at 1280px
     and ~0.66 at 1024px, which renders 12.5px card titles at 10px and 8px and the
     12px annotations at less than that. Below ~0.8 the fix defeats itself: it
     trades "annotations cropped but panable" for "nothing legible", and Pan &
     zoom is off by default so a narrow desktop would be stuck there. Cropping is
     recoverable; unreadable is not. (fitZoom itself lives at module scope.) */
  const resetView = useCallback(() => {
    const w = flowRef.current?.clientWidth ?? 900
    const zoom = fitZoom(w)
    /* Load fully scrolled up: the viewport's top edge lands exactly on the
       pan extent's top line, so nothing sits above the fold and the first
       upward scroll gesture has nowhere silly to go. */
    rf.setViewport({ x: w / 2, y: TOP_ALLOWANCE * zoom, zoom })
  }, [rf])

  /* THE CONTAINER CAN RESIZE WITHOUT THE WINDOW DOING SO. Both the spine's x
     (pinned to w/2) and the fit zoom are functions of the container width, and
     both were computed once in onInit — so when the student-side Athena dock
     opens and takes 24rem off the app core, the map stayed anchored to the old
     centre: the spine sat off to the right and the left lane was cropped, with no
     gesture to recover it (pan is off by default).
     Re-anchor on the container itself. The vertical position is preserved about
     the viewport centre (same maths as snapBackView) so nobody gets yanked to the
     top mid-read, and it stands down entirely while Pan & zoom is on — there the
     reader owns the camera and this would fight them. */
  useEffect(() => {
    const flow = flowRef.current
    if (!flow || panZoom) return
    let lastWidth = flow.clientWidth
    setContainerW(lastWidth)
    const ro = new ResizeObserver(() => {
      const w = flow.clientWidth
      const h = flow.clientHeight
      if (!w || !h || Math.abs(w - lastWidth) < 1) return
      lastWidth = w
      setContainerW(w)
      /* The container-width state above always updates (the lane's athX and the
         layout depend on it); the CAMERA re-frame is narrower.

         Stand down entirely while the Class Lens is open: this re-frame lands on
         the spine, but with the lens up the delta-based effect below owns
         horizontal framing — it keeps the map beside the open dossier card via
         freeCenterXFor. Spine-centering here would snap the camera off that card
         on any resize (exiting full-screen, the window changing). And never write
         mid-tween — guard on settling.current like every other viewport writer in
         this file, and set it so the two ResizeObservers don't fight over the same
         resize. If the camera was parked at the lane pose, the athX-keyed effect
         below waits this 60ms out and re-parks on the lane's NEW x. */
      if (lensOn || settling.current) return
      const vp = rf.getViewport()
      const zoom = fitZoom(w)
      const centerFlowY = (h / 2 - vp.y) / (vp.zoom || 1)
      settling.current = true
      rf.setViewport({ x: w / 2, y: h / 2 - centerFlowY * zoom, zoom })
      setTimeout(() => { settling.current = false }, 60)
    })
    ro.observe(flow)
    return () => ro.disconnect()
  }, [rf, panZoom, lensOn])
  /* React Flow is up: set the default view, then honour a ?node= deep link. Done
     here rather than on mount because resetView() would otherwise throw the
     camera straight off the card the link had just anchored to. The arrival
     itself pushes nothing, so closing the card returns the reader to whatever
     page they came from. */
  const onInit = useCallback(() => {
    resetView()
    /* Nodes mount the moment the camera is placed — no extra hold. The
       "title first" beat already happened in the loading skeleton (§19), and
       the Motion rise + per-node stagger IS the "slowly show the nodes" part;
       a timer here only lengthened the stretch where the ghost cards' spot
       sat empty. */
    setEntered(true)
    const key = new URLSearchParams(window.location.search).get('node')
    if (!key) return
    /* Claim the key BEFORE opening, so the arrival itself doesn't push an entry —
       then hand it straight back if nothing on the map answers to it, which also
       strips the dead param from a shared link to a node that has since gone. */
    nodeParam.current = key
    if (!openByKey(key)) nodeLinkMissed()
  }, [resetView, openByKey, nodeLinkMissed])

  /* leaving pan-&-zoom recenters the spine + resets zoom to 1 (so vertical scroll
     works again) WITHOUT jumping to the top — keep the content that was at the
     viewport's vertical center fixed as the zoom returns to 1. */
  const snapBackView = useCallback(() => {
    const flow = flowRef.current
    if (!flow) return
    const w = flow.clientWidth, h = flow.clientHeight
    const vp = rf.getViewport()
    const centerFlowY = (h / 2 - vp.y) / (vp.zoom || 1)
    settling.current = true
    rf.setViewport({ x: w / 2, y: h / 2 - centerFlowY, zoom: 1 }, { duration: 300 })
    setTimeout(() => { settling.current = false }, 340)
  }, [rf])

  const wasPan = useRef(false)
  useEffect(() => {
    if (panZoom) wasPan.current = true
    else if (wasPan.current) { wasPan.current = false; snapBackView() }
  }, [panZoom, snapBackView])

  /* RE-FRAME WHEN THE CANVAS CHANGES WIDTH — full-screen in and out, mainly.
     x is an absolute pixel offset, so a width change silently invalidates it:
     the framing centre moves but the camera doesn't. Without the lens the spine
     just sits off-centre until the next scroll lets onMove's pin correct it;
     WITH the lens it never recovers, because lensPinX still holds the x computed
     for the old width and the pin actively holds the map there.
     Shifting x by the DELTA between the old and new framing centres is right in
     both modes: default mode's x already IS that centre, so it lands exactly on
     the new one, and Pan & zoom keeps whatever horizontal offset the reader had.
     Instant, not tweened — a resize is already an abrupt change, and animating
     after it reads as lag. Height-only changes (the off-map bench opening) are
     ignored: y is absolute too, but a taller canvas revealing more map is what a
     vertical scroll surface should do. */
  useEffect(() => {
    const flow = flowRef.current
    if (!flow || !entered) return
    let w = flow.clientWidth
    const ro = new ResizeObserver(() => {
      const nw = flow.clientWidth
      if (!nw || Math.abs(nw - w) < 1) return
      const from = lensOn ? freeCenterXFor(w) : w / 2
      const to = lensOn ? freeCenterXFor(nw) : nw / 2
      w = nw
      if (lensOn) lensPinX.current = to
      /* Never write the camera mid-tween. A width change landing inside the
         lens' 450ms framing tween (full-screening within 450ms of picking a
         student) would cancel it and strand zoom at whatever intermediate value
         it had reached, with nothing left to correct it. The pin above is
         already re-derived, so skipping only the immediate nudge is safe: the
         tween finishes at the right zoom and the next scroll snaps x to the pin. */
      if (settling.current) return
      const vp = rf.getViewport()
      settling.current = true
      rf.setViewport({ ...vp, x: vp.x + (to - from) })
      setTimeout(() => { settling.current = false }, 60)
    })
    ro.observe(flow)
    return () => ro.disconnect()
  }, [lensOn, entered, rf])

  /* enable position gliding once the entrance animation + first measure settle */
  useEffect(() => {
    if (!entered) return
    const t = setTimeout(() => setGlide(true), 700)
    return () => clearTimeout(t)
  }, [entered])

  /* the floating controls (tools, off-map bench) start fully visible — on
     load AND when scrolling begins — then settle into a slightly dim resting
     state a few seconds after the user first moves the map, so they stop
     competing with passing content. Moving the mouse near them (a padded
     :hover halo, see CSS) restores full colour. One one-shot timer armed by
     the first onMove — no React state, no per-event work afterwards. */
  const chromeDimTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /* The lane pose's viewport x: Athena's lane fully in view, its right edge a
     breath from the frame. */
  const lanePoseX = useCallback((w: number, zoom: number) => w - (athX + ATH_W + ATH_SNAP_PAD) * zoom, [athX])
  const onMove = useCallback((_e: MouseEvent | TouchEvent | null, vp: Viewport) => {
    /* KEEP THE SPINE CENTRED WHILE PAN-&-ZOOM IS OFF. Default mode offers no
       horizontal gesture at all (panOnScroll is Vertical-only, panOnDrag off),
       but React Flow still zooms on ⌘/ctrl+wheel — which is exactly what a
       trackpad pinch sends — and it zooms about the POINTER. That slid the map
       off-centre with no gesture left to recover it: it sat shifted until the
       professor toggled Pan & zoom twice, whose snap-back was the only thing
       that ever reset x. Re-anchoring x makes a stray pinch zoom about the
       anchor line instead, so the tree cannot drift away.
       Terminates: x is set to exactly the anchor, so the onMove this triggers
       is inside the epsilon and doesn't recurse.

       The anchor is a POSE: spine centred (w/2), or — after the edge
       affordance snapped over — Athena's lane in view. No free horizontal
       travel exists between them; the affordance's tween is the only mover.
       The lens keeps its own pin untouched. */
    if (_e != null) {
      /* The user took over. If a snap tween is mid-flight, hand the camera
         back NOW — leaving `settling` up would bypass the pose pin for the
         rest of the guard window and then recover with an untweened yank. */
      if (settling.current) {
        settling.current = false
        if (snapTimer.current) { clearTimeout(snapTimer.current); snapTimer.current = null }
      }
    }
    if (!panZoom && !detail && !settling.current) {
      const w = flowRef.current?.clientWidth ?? 0
      if (w) {
        const laneX = hasAthenaLane && lensPinX.current == null && atLanePose ? lanePoseX(w, vp.zoom) : null
        /* under the lens the pin anchors to the card's free area, not w/2 —
           same anti-drift protection, shifted centre line */
        const target = laneX != null && laneX < w / 2 ? laneX : lensPinX.current ?? w / 2
        if (Math.abs(vp.x - target) > 0.5) rf.setViewport({ ...vp, x: target })
      }
    }
    if (chromeDimTimer.current || rootRef.current?.dataset.chromeDim) return
    chromeDimTimer.current = setTimeout(() => {
      if (rootRef.current) rootRef.current.dataset.chromeDim = '1'
    }, 3500)
  }, [panZoom, detail, rf, hasAthenaLane, atLanePose, lanePoseX])

  /* The edge affordance's snap: glide the camera between the two poses. The
     ONLY horizontal mover in default mode — scroll gestures never travel
     sideways — so it's also the keyboard route (the affordance is a button).
     Going over travels VERTICALLY too, to the note nearest the current centre
     line: the lane is sparse (notes sit at their module bands), so an x-only
     snap from the top of the map landed on empty margin — the click's own
     feedback contradicting the "n from Athena" label it came from. */
  const goToPose = useCallback((toLane: boolean) => {
    const flow = flowRef.current
    if (!flow) return
    const w = flow.clientWidth, hgt = flow.clientHeight
    if (!w) return
    const vp = rf.getViewport()
    const laneX = lanePoseX(w, vp.zoom)
    const target = toLane && laneX < w / 2 ? laneX : w / 2
    let y = vp.y
    if (toLane) {
      const centerFlowY = (hgt / 2 - vp.y) / (vp.zoom || 1)
      let best: number | null = null
      for (const nd of nodes) {
        if (nd.type !== 'athena') continue
        const ncy = nd.position.y + (nd.measured?.height ?? ATH_EST_H) / 2
        if (best == null || Math.abs(ncy - centerFlowY) < Math.abs(best - centerFlowY)) best = ncy
      }
      if (best != null) y = hgt / 2 - best * vp.zoom
    }
    setAtLanePose(target !== w / 2)
    settling.current = true
    rf.setViewport({ ...vp, x: target, y }, { duration: tweenMs(300) })
    if (snapTimer.current) clearTimeout(snapTimer.current)
    snapTimer.current = setTimeout(() => { settling.current = false }, tweenMs(300) + 40)
  }, [rf, lanePoseX, nodes])

  /* The lane's x is width-derived, so a resize moves the lane itself. A camera
     parked at the lane pose re-parks on the lane's NEW x — without this the
     re-anchor observer's spine framing silently threw the reader back to the
     course map mid-read (opening the Athena dock is exactly this resize).
     (A lane that left the map entirely resets the flag in the module-toggle
     handler itself — the one event that can remove it.) */
  useEffect(() => {
    if (!atLanePose || !hasAthenaLane) return
    const park = () => {
      const w = flowRef.current?.clientWidth ?? 0
      if (!w) return
      const vp = rf.getViewport()
      const laneX = lanePoseX(w, vp.zoom)
      if (laneX < w / 2 && Math.abs(vp.x - laneX) > 0.5) rf.setViewport({ ...vp, x: laneX })
    }
    /* Never mid-tween: this effect also fires the moment goToPose SETS the
       flag, and an instant x-write here would cancel that glide (and eat its
       vertical travel). But the correction can't just be dropped — a resize
       landing inside the tween window would otherwise strand the camera at
       the spine with the label reading "back" — so it re-runs after the tween
       has parked. */
    if (!settling.current) { park(); return }
    const t = setTimeout(() => { if (!settling.current) park() }, tweenMs(300) + 80)
    return () => clearTimeout(t)
  }, [athX, containerW, atLanePose, hasAthenaLane, lanePoseX, rf])

  /* Keyboard focus must be SEEN: an Athena card is the only door to its
     artifact, and tabbing onto one parked 1600px below the fold left the
     focus ring nowhere on screen (nothing scrolls a React Flow node into
     view on focus). When focus lands on a note outside the frame, glide the
     camera to it — the lane pose on x, the note centred on y. Capture-phase
     on the flow container so it costs nothing per node. */
  const onCanvasFocus = useCallback((e: ReactFocusEvent<HTMLDivElement>) => {
    if (panZoom || detail || lensPinX.current != null) return
    const card = (e.target as HTMLElement).closest?.('.athx')
    const flow = flowRef.current
    if (!card || !flow) return
    const fr = flow.getBoundingClientRect()
    const r = card.getBoundingClientRect()
    if (r.top >= fr.top && r.bottom <= fr.bottom && r.left >= fr.left && r.right <= fr.right) return
    const nid = (card.closest('.react-flow__node') as HTMLElement | null)?.dataset.id
    const n = nid ? rf.getNode(nid) : undefined
    if (!n) return
    const w = flow.clientWidth, hgt = flow.clientHeight
    const vp = rf.getViewport()
    const laneX = lanePoseX(w, vp.zoom)
    const cy = n.position.y + (n.measured?.height ?? ATH_EST_H) / 2
    setAtLanePose(laneX < w / 2)
    settling.current = true
    rf.setViewport({ zoom: vp.zoom, x: laneX < w / 2 ? laneX : vp.x, y: hgt / 2 - cy * vp.zoom }, { duration: tweenMs(300) })
    if (snapTimer.current) clearTimeout(snapTimer.current)
    snapTimer.current = setTimeout(() => { settling.current = false }, tweenMs(300) + 40)
  }, [panZoom, detail, rf, lanePoseX])

  /* The strip must not be a scroll dead spot: it sits outside React Flow's
     panes, so a wheel gesture that lands on it would otherwise vanish — the
     rightmost 60px of canvas silently refusing to scroll. Re-dispatch onto
     the pane and the map keeps moving under the resting pointer. */
  const forwardWheel = useCallback((e: ReactWheelEvent<HTMLButtonElement>) => {
    const pane = flowRef.current?.querySelector('.react-flow__pane')
    pane?.dispatchEvent(new WheelEvent('wheel', {
      deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
      clientX: e.clientX, clientY: e.clientY,
      ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
      bubbles: true, cancelable: true,
    }))
  }, [])
  useEffect(() => () => { if (chromeDimTimer.current) clearTimeout(chromeDimTimer.current) }, [])

  /* Escape closes the detail cloud.
     Honours the same layer contract as the lens handler above — skip when another
     overlay already claimed this press, then claim it ourselves. Without the
     defaultPrevented check this fired IN ADDITION to whichever overlay was layered on
     top of an open card, and closeDetail pops the history entry the card pushed, so a
     press meant to dismiss a drawer navigated the browser out of the roadmap instead.
     That is why it looked intermittent: it needed a card open UNDERNEATH something else. */
  useEffect(() => {
    if (!detail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      closeDetail()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [detail, closeDetail])
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  /* full-screen the canvas window (native Fullscreen API on the root) */
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen()
    else rootRef.current?.requestFullscreen?.()
  }, [])
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  /* Whether the lane pose differs from the spine pose at all — with the lane's
     x derived from the width this is effectively "the lane exists", but keep
     the guard so the affordance never offers a snap that goes nowhere. */
  const laneOffscreen =
    hasAthenaLane && (containerW === 0 || lanePoseX(containerW, fitZoom(containerW)) < containerW / 2)
  /* Default mode scrolls VERTICALLY only, lane or no lane — the trackpad's
     sideways travel was janky against the pose snap, so the edge affordance
     is now the one way over. */
  const interaction = panZoom
    ? { panOnScroll: false, zoomOnScroll: true, panOnDrag: true, zoomOnPinch: true, zoomOnDoubleClick: false }
    : { panOnScroll: true, panOnScrollMode: PanOnScrollMode.Vertical, zoomOnScroll: false, panOnDrag: false, zoomOnPinch: false, zoomOnDoubleClick: false }
  /* the map freezes while the detail cloud is open — only the card is interactive */
  const detailActive = !!detail
  const flowInteraction = detailActive
    ? { panOnScroll: false, zoomOnScroll: false, panOnDrag: false, zoomOnPinch: false, zoomOnDoubleClick: false }
    : interaction

  /* bench: overflow cue — fade the clipped edge instead of a scrollbar */
  useEffect(() => {
    const rows = [draftRowRef.current, classroomRowRef.current].filter((r): r is HTMLDivElement => r !== null)
    const cleanups = rows.map((row) => {
      const upd = () => {
        row.classList.toggle('fadeL', row.scrollLeft > 4)
        row.classList.toggle('fadeR', row.scrollLeft < row.scrollWidth - row.clientWidth - 4)
      }
      row.addEventListener('scroll', upd)
      const ro = new ResizeObserver(upd)
      ro.observe(row)
      upd()
      return () => { row.removeEventListener('scroll', upd); ro.disconnect() }
    })
    return () => cleanups.forEach((fn) => fn())
  }, [])

  /* click outside closes the drawer / the settings popover */
  useEffect(() => {
    if (!benchOpen) return
    const onDoc = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.bench')) setBenchOpen(false) }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [benchOpen])
  useEffect(() => {
    if (!settingsOpen) return
    const onDoc = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.ctools')) setSettingsOpen(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setSettingsOpen(false)
      /* Return focus to THIS popover's own trigger, or Escape leaves the keyboard
         nowhere. Held as a ref: there are two `.ctools` clusters and the
         right-hand one renders first, so a `.ctools .tbtn` query matched the wrong
         cluster's button — Enter afterwards opened an unrelated drawer. */
      settingsBtnRef.current?.focus()
    }
    document.addEventListener('click', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [settingsOpen])

  /* off-map bench count: the upload buckets. Unplaced activities left the bench
     for the map itself (§22), so they no longer have a tally here. */
  const nF = quizUploads.length + classroomUploads.length
  const chip = (n: number, one: string, many: string, c: string) => n ? (
    <span className="schip" style={cssVars({ '--k': c })}><i />{n} {n === 1 ? one : many}</span>
  ) : null

  return (
    <JourneyOverlayContext.Provider value={journeyOverlay}>
    <div ref={rootRef} className={`rmproto${benchOpen ? ' bench-open' : ''}${detail ? ' d-open' : ''}${closing ? ' d-closing' : ''}${lensOn ? ' lens-on' : ''}${kpOn ? ' kp-on' : ''}${panel ? ' panel-open' : ''}`}>
      {/* class lens (professor): the top-RIGHT cluster holds the "viewing
          whole class" dock pill (its dropdown is the ONLY student picker and
          hosts the "Open class analytics" action) with Tracked skills at the
          far right — same chrome-dim behaviour as the tools cluster. The
          read-only banner comes in at the top-center while a student is
          overlaid. */}
      {lensEnabled && (
        <>
          <div className="ctools ctools-r">
            <ClassLensDock
              journeys={journeys}
              loading={journeysLoading}
              selected={lensStudent}
              onEnsure={onEnsureJourneys}
              onSelect={setLensStudentId}
              onOpenAnalytics={onOpenAnalytics}
            />
            {/* Tracked skills retires while the lens views ONE student: it
                curates what the whole class is measured on, so it's the wrong
                thing to reach for from a single student's dossier — and it also
                clears the crowded top row above the card. It comes back with
                the whole-class view. */}
            {topicSetup && roadmapData && !lensOn && (
              <button
                type="button"
                className={`tbtn${skillsBadge > 0 ? ' tbtn-alert' : ''}`}
                onClick={() => setPanel('skills')}
                title={skillsBadge > 0 ? `${skillsBadge} new skill${skillsBadge > 1 ? 's' : ''} to review` : 'Tracked skills'}
              >
                Tracked skills
                {skillsBadge > 0 && (
                  /* the em-shine sweep (tbtn-alert) is the whole cue — mellow,
                     no dot, and the button skips chrome-dim until resolved */
                  <span className="sr-only">{skillsBadge} skills waiting to review</span>
                )}
              </button>
            )}
            {/* the shine says "look here"; this says what for. The map's dotted-
                arrow marginalia, pointing back up at the pebble — decorative for
                AT (the button's sr-only text already carries the count), and it
                retires on its own timer, or the moment the professor opens a
                panel or confirms. */}
            {topicSetup && roadmapData && skillsBadge > 0 && nudge !== 'gone' && !panel && !detail && !lensOn && (
              <div className={`tsnote${nudge === 'out' ? ' out' : ''}`} aria-hidden>
                {/* the same hand geometry AnnotationLayer draws: a cubic sweeping
                    into the target plus the two-stroke chevron from headAt(). The
                    last control point sits directly BELOW the tip (12,30 → 10,4)
                    so the pen arrives near-vertically — on a shallow approach the
                    chevron's legs splay flat and read as a "7" instead of an
                    arrow. Tip at x=10 of a 54-wide box, flush-right container →
                    it lands on the pebble's middle. */}
                <svg className="an an-marrow dots" viewBox="0 0 54 48" width="54" height="48">
                  <path className="curve" d="M 50 44 C 40 42 12 30 10 4" />
                  <path className="head" d="M 10 4 l -3.1 7.9 M 10 4 l 4.3 7.4" />
                </svg>
                <span className="an an-margin dots">
                  <b>{skillsBadge} new skill{skillsBadge > 1 ? 's' : ''}</b> found in your materials — confirm what to track
                </span>
              </div>
            )}
          </div>
          {topicSetup && roadmapData && (
            <TrackedSkillsDrawer
              sectionId={sectionId as string}
              topicSetup={topicSetup}
              unconfirmedCount={unconfirmedTopicCount}
              concepts={concepts}
              roadmapData={roadmapData}
              open={panel === 'skills'}
              onOpenChange={onSkillsOpenChange}
              onUnconfirmedChange={setSkillsBadge}
            />
          )}
          {/* The read-only lens strip is RETIRED — the dock pill already reads
              "viewing <name>" (and stays undimmed while a lens is on), and its
              dropdown is the way back to whole class. The strip's 5-state
              legend (Mastered · Review next · In progress · Not started · Not
              yet covered) is PARKED, not deleted — <LensStrip> still lives in
              roadmap-class-lens.tsx; re-mount it (or lift its .leg block out)
              once the legend's new home is decided:
          {lensStudent && <LensStrip student={lensStudent} index={lensIndex} onClear={() => setLensStudentId(null)} />} */}
          {/* the student dossier — the floating card over the canvas' left
              edge while the lens views one student. Photo + AI narrative +
              the concrete numbers; ‹ › walk the roster. The canvas never
              reflows or dims; what the card covers is reachable by scrolling
              (or horizontally in Pan & zoom mode), and the left-strip chrome
              (settings popover, bench) shifts right of it via .lens-on. The
              live region below announces roster walks — it sits OUTSIDE the
              keyed card so the text CHANGE is what screen readers hear. */}
          <span className="sdsr" role="status">{lensStudent ? `Viewing ${lensStudent.name}` : ''}</span>
          {lensStudent && sectionId && (
            <StudentDossierCard
              key={lensStudent.studentId}
              student={lensStudent}
              index={lensIndex}
              students={journeys?.students ?? []}
              classStats={journeys?.classStats ?? null}
              sectionId={sectionId}
              onSelect={setLensStudentId}
              onClear={onClearLens}
            />
          )}
          <ClassAnalyticsDrawer
            open={panel === 'analytics'}
            onClose={onCloseAnalytics}
            /* non-null inside this block: lensEnabled already required it */
            sectionId={sectionId as string}
            journeys={journeys}
            concepts={concepts}
          />
        </>
      )}
      {/* canvas tools, top-left: settings (node style) + pan-&-zoom */}
      <div className="ctools">
        {/* Icon only — the pebble never names the current setting. The popover
            below is where node style / annotation detail are read and changed. */}
        <button ref={settingsBtnRef} type="button" className="tbtn tbtn-icon" aria-label="Canvas settings" title="Canvas settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
          <Settings2 />
        </button>
        <button type="button" className="tbtn" aria-pressed={panZoom} title="Scroll to zoom, drag to pan" onClick={() => setPanZoom((o) => !o)}>
          <Hand /> Pan &amp; zoom
        </button>
        <button type="button" className="tbtn tbtn-icon" aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'} aria-pressed={isFullscreen} title={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>
          {isFullscreen ? <Minimize2 /> : <Maximize2 />}
        </button>
        {settingsOpen && (
          <div className="spop">
            <span className="blabel">NODE STYLE</span>
            <div className="vtog" role="group" aria-label="Node style">
              <button type="button" aria-pressed={!calm} onClick={() => setCalm(false)}>expressive</button>
              <button type="button" aria-pressed={calm} onClick={() => setCalm(true)}>calm</button>
            </div>
            <span className="blabel">ANNOTATIONS</span>
            <div className="vtog" role="group" aria-label="Annotation detail">
              <button type="button" aria-pressed={annotDetail === 'all'} onClick={() => setAnnotDetail('all')}>everything</button>
              <button type="button" aria-pressed={annotDetail === 'focused'} onClick={() => setAnnotDetail('focused')}>focused</button>
            </div>
          </div>
        )}
      </div>

      {/* Athena lane edge — the WAY IN, on the frame's right border. The
          margin caption (variant D) is a STANDING cue, always inked on the
          corner; the violet shade over the full edge still waits for
          hover/focus, and a click glides the camera to the lane pose (the
          prototype's scroll-snap, as one deliberate move). Also the only
          keyboard route to her notes. Hidden while a card is open or the
          reader owns the camera (Pan & zoom, lens). */}
      {/* the knowledge-path bar: what's lit (honestly — a path can lose stops
          when material leaves the course), the way back to the WHY (the note's
          modal opens over the lens and returns to it), and the way out. The ✕
          hands the camera back to exactly where it stood. */}
      {kpOn && !detail && kpath && (() => {
        const litStops = kpath.stops.filter((s) => s.hit).length
        const total = kpath.stops.length
        return (
          <div className="kp-bar" role="region" aria-label="Knowledge path">
            <span className="kp-bar-t">
              <span aria-hidden>✦ </span>
              the path to “{kpath.focus.title || kpArtifact?.title}”
              {litStops < total ? ` — ${litStops} of ${total} stops on your map` : ''}
            </span>
            {kpArtifact && (
              <button type="button" className="kp-why" onClick={() => openByKey(athenaNodeKey(kpArtifact.id))}>
                Why these stops?
              </button>
            )}
            <button
              ref={kpCloseRef}
              type="button"
              className="kp-close"
              aria-label={`Close the knowledge path — ${litStops} ${litStops === 1 ? 'stop' : 'stops'} lit — back to your map`}
              onClick={closeKpath}
            >
              <span aria-hidden>✕</span><span className="kp-close-t"> Close — back to your map</span>
            </button>
          </div>
        )
      })()}
      {laneOffscreen && !detailActive && !panZoom && !lensOn && !kpOn && !atLanePose && (
        <button
          type="button"
          className="lane-edge"
          onClick={() => goToPose(true)}
          onWheel={forwardWheel}
          aria-label={`${athenaCount} ${athenaCount === 1 ? 'note' : 'notes'} from Athena — she left these for you in chat`}
        >
          <span className="lane-edge-msg">
            {athenaCount} {athenaCount === 1 ? 'note' : 'notes'} from Athena<small>she left these for you in chat</small>
            <svg className="lane-edge-arr" viewBox="0 0 46 52" aria-hidden>
              <path d="M4 6 C 30 8, 42 20, 38 44" />
              <path d="M31 36 l7 9 8 -7" />
            </svg>
          </span>
        </button>
      )}
      {/* The way back, parked at the lane: the caption ITSELF is the button —
          deliberately NOT an edge strip, so the notes keep every px of their
          own click targets. Same hand voice, mirrored arrow at the map. */}
      {laneOffscreen && !detailActive && !panZoom && !lensOn && !kpOn && atLanePose && (
        <button type="button" className="lane-back" onClick={() => goToPose(false)} onWheel={forwardWheel}>
          back to the course map<small>tap to go back</small>
          <svg className="lane-edge-arr" viewBox="0 0 46 52" aria-hidden>
            <path d="M42 6 C 16 8, 4 20, 8 44" />
            <path d="M15 36 l-7 9 -8 -7" />
          </svg>
        </button>
      )}

      {/* the roadmap canvas — React Flow owns pan/zoom, edges & the dotted grid */}
      {/* tabIndex -1: the knowledge-path lens hands focus back here on close,
          so a keyboard student isn't dumped at the top of the document */}
      <div className={`rmproto-flow${glide ? ' glide' : ''}${panZoom ? ' panzoom' : ''}${entered ? ' cam' : ''}`} ref={flowRef} tabIndex={-1} onFocusCapture={onCanvasFocus}>
        <ReactFlow
          nodes={entered ? displayNodes : NO_NODES}
          edges={entered ? edges : NO_EDGES}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onMove={onMove}
          onInit={onInit}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          /* Off globally — only the unplaced cards opt in, per node.
             Everything else on the map is laid out, not arranged by hand. */
          nodesDraggable={false}
          /* OFF: this canvas has its own two-pose camera (onMove pins x to the
             current anchor), and React Flow's auto-pan drives the viewport from
             its own rAF loop — the two fight over the same transform mid-drag.
             Nothing needs panning to be reachable either: a whole week band is a
             drop target (CATCH_X/CATCH_Y), so any week on screen can take it. */
          autoPanOnNodeDrag={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.35}
          maxZoom={2.5}
          translateExtent={detailActive ? undefined : extentOf(contentHeight, lensOn || kpOn, hasAthenaLane ? athX : null)}
          {...flowInteraction}
        >
          <Background variant={BackgroundVariant.Dots} gap={26} size={1.2} color="#bfc7d4" />
          {/* the annotation layer lives in flow coordinates (ViewportPortal),
              so margin notes / flags / rings pan & zoom with their nodes */}
          <AnnotationLayer nodes={nodes} annotations={drawnAnnotations} height={contentHeight} />
          <div role="status" aria-live="polite" className="sr-only">
            {bakingTitles.length > 0 ? `Writing a few questions on ${bakingTitles.join(', ')}` : ''}
          </div>
          {/* overall-completion roll-up — the old bar's arrangement (big % ·
              meter · status tally), low-fi in the canvas language, floating
              above the first module */}
          {/* Hidden while a node card is open. The roll-up is 1080px centred on the
              spine, and the open-card view centres the spine in the ~340px strip
              left of the drawer — so the headline number itself lands off the left
              edge and what survives is a meter and a tally with no number attached,
              which reads as breakage rather than de-emphasis. It returns on close. */}
          {!detail && <ViewportPortal>
            {/* Athena's corner of the paper: a soft blue wash under her lane
                (the prototype's aglow), so the margin column reads as HER
                ground even before a note is in view. On the paper, not the
                frame — it pans and zooms with the notes it backs. */}
            {hasAthenaLane && (
              <div
                className="ath-wash"
                style={{ position: 'absolute', left: athX - 56, top: -TOP_ALLOWANCE, width: ATH_W + 200, height: contentHeight + TOP_ALLOWANCE + 120 }}
              />
            )}
            {/* The page title, drawn on the paper itself: the module cards'
                serif voice at page scale, big and bold, set left of and above
                the completion station (clear of it on both axes), a pen swash
                inking itself in underneath. Scrolls with the map like
                everything else on the sheet. */}
            <div className="hd hd-t" style={{ position: 'absolute', left: -540, top: -170, transform: 'translateY(-100%)', width: 620 }}>
              {/* a real h1 — the populated page's only heading landmark (the
                  off-canvas states carry their own via RoadmapPaper) */}
              <RoadmapTitleInk desc={headerDesc} />
            </div>
            <div className="rollup">
              {/* "complete" is the professor's word — it's their delivery. A
                  student's number mixes what the class has been taught with the
                  extras they ticked themselves, so it is coverage, not their own
                  completion; the personal mastery bar that used to sit beside it
                  and make that contrast is gone. */}
              <div className="rnum">
                <b>{progress.pct}%</b>
                <span>{audience === 'stu' ? 'of the course covered' : 'of the course complete'}</span>
              </div>
              <div className="rbar">
                <div className="track">
                  <i className="fdone" style={{ width: `${(100 * progress.done) / Math.max(progress.total, 1)}%` }} />
                  <i className="fprog" style={{ width: `${(100 * progress.prog) / Math.max(progress.total, 1)}%` }} />
                </div>
                {/* the mastery mark — a hatched highlighter swipe over the ink
                    up to the mastery level (masteryX: scaled to what's been
                    delivered, never the whole bar), overhanging the meter like
                    a real pen stroke over a ruled line */}
                {mastery && (
                  /* +6px squares the -3px left overhang, so at 100% mastery the
                     swipe reaches exactly the ink's right edge */
                  <span className="mhl" style={cssVars({ '--t': mastery.color, width: `calc(${masteryX}% + 6px)` })} />
                )}
                <i className="kinds">
                  <span><em style={{ background: 'var(--c-done)' }} />{progress.done} complete</span>
                  <span><em style={{ background: 'var(--accent)' }} />{progress.prog} in progress</span>
                  <span><em style={{ background: '#94a3b8' }} />{progress.todo} not started</span>
                  {/* names the mastery swipe — pushed to the meter's other end.
                      The title states the scaling rule the mark alone can't. */}
                  {mastery && (
                    <span className="mkey" style={cssVars({ '--t': mastery.color })} title="Average mastery of the material delivered so far — not of the whole course"><em />{mastery.pct}% {mastery.label}</span>
                  )}
                </i>
              </div>
              {/* A coverage read failed or was truncated. Say so where the number
                  is read: an incomplete read derives as "nothing delivered", so
                  staying silent means confidently understating the whole term. */}
              {coverageDegraded ? (
                <div className="rwarn">
                  Some activity couldn’t be read just now, so this may be lower than the real figure.
                </div>
              ) : null}
            </div>
          </ViewportPortal>}
          {/* Athena's knowledge-path ink — rings (the annotation layer's own
              pen loop), numbered stops, wires and the "start here" note
              (issue #94). Its OWN portal, outside the !detail gate: opening a
              stop's card must not blank the path — the map keeps telling the
              story beside the modal (it recedes via CSS, never unmounts). */}
          {kpOn && kpath && (
            <ViewportPortal>
              <KnowledgePathInk
                stops={kpath.stops.flatMap((s) => (s.hit ? [{ title: s.title, masteryPct: s.masteryPct, n: s.n, box: s.hit.box }] : []))}
                focus={kpath.focus.hit ? { title: kpath.focus.title, box: kpath.focus.hit.box } : null}
                weakestN={kpath.weakestN}
                obstacles={kpObstacles}
              />
            </ViewportPortal>
          )}
        </ReactFlow>
      </div>

      {/* node detail — the "dream cloud": haze blob + the detail card. Remounts
          per node (keyed by id) so its skill/page state resets on open & navigate. */}
      {detail && (
        <>
          <div className="dhaze" />
          <NodeDetail
            key={detail.nodeId}
            item={detail.item}
            onClose={closeDetail}
            onNavigate={navigateTo}
            aiTutorHref={aiTutorHref}
            selfCheck={selfCheckFor(detail.item)}
            nodeCheck={nodeCheckFor(detail.item)}
            nodeCheckReview={nodeCheckReviewFor(detail.item)}
            loadQuizQuestions={onLoadQuizQuestions}
            loadAssignmentContent={onLoadAssignmentContent}
            loadSessionContent={onLoadSessionContent}
            conceptRefs={conceptRefs}
            navigable={navigableTitles}
            audience={audience}
            sectionId={sectionId}
            onSaveArtifactState={onSaveArtifactState}
            onArchiveArtifact={onArchiveArtifact}
            onArchiveNode={archiveOn ? archiveNode : undefined}
          />
        </>
      )}

      {/* the Archive: a tab peeking from the bottom edge → slides the bin up.
          Professor flavour — drafts and unplaced resources are authoring state
          hidden from students. */}
      {audience === 'prof' && <aside className="bench">
        <div className="bpanel" id="offmap-panel">
          {quizUploads.length > 0 && (
            <>
              <div className="blabel">QUIZ UPLOADS
                <span className="bhide" role="img" aria-label="Hidden from students" title="Hidden from students"><EyeOff /></span>
                {/* Parked with the grip styling in roadmap-prototype.css: there is
                    no drag handler on the bench, so this hint promised an
                    interaction that did nothing. Restore it with the feature.
                <i className="draghint">drag any card onto a module to place it on the map</i> */}
              </div>
              <div className="brow" ref={draftRowRef}>{quizUploads.map((r, i) => <Res key={i} r={bareCard(r)} calm={calm} />)}</div>
            </>
          )}
          {classroomUploads.length > 0 && (
            <>
              {/* Same eye-off + title as QUIZ UPLOADS: these are unshared in-class
                  uploads, so the group needs to say so too, not just each card. */}
              <div className="blabel">CLASSROOM UPLOADS
                <span className="bhide" role="img" aria-label="Hidden from students until you share them" title="Hidden from students until you share them"><EyeOff /></span>
              </div>
              <div className="brow" ref={classroomRowRef}>{classroomUploads.map((r, i) => <Res key={i} r={bareCard(r)} calm={calm} />)}</div>
            </>
          )}
          {/* UNTRACKED ACTIVITIES is gone from here: an unplaced quiz or
              assignment now waits ON the map near the today-line (§22), where
              the professor is already looking and can drag it onto a week. What
              the bench holds is what genuinely isn't on the map — the hidden
              upload buckets, and the nodes taken off it on purpose. */}
          {archivedNodes.length > 0 && (
            <>
              <div className="blabel">OFF THE MAP
                <span className="bhide" role="img" aria-label="Hidden from students too" title="Hidden from students too"><EyeOff /></span>
              </div>
              <div className="brow">
                {archivedNodes.map((a) => (
                  <div className="parked" key={a.key}>
                    {isArchivedRes(a) ? <Res r={a.r} calm={calm} /> : <SessionCard s={a.s} />}
                    <div className="arch-acts">
                      <span className="parked-from">{a.where === NO_WEEK ? 'wasn’t on a week' : `from ${a.where}`}</span>
                      <button
                        type="button"
                        className="arch-btn"
                        aria-label={`Put “${isArchivedRes(a) ? a.r.t : a.s.t}” back on the map`}
                        onClick={() => restoreNode(a.key, isArchivedRes(a) ? a.r.t : a.s.t)}
                      >
                        Put back
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {/* Empty. The tray is a real destination now (every node modal can send
              something here), so it has to answer "why is this blank?" itself —
              a panel that opens onto a 4px sliver reads as broken. */}
          {nF === 0 && archivedNodes.length === 0 && (
            <div className="bempty">
              <b>Nothing in the Archive.</b>
              <span>Open any node on the map and choose “Move to Archive” — it waits here, and goes back to the same spot when you put it back.</span>
            </div>
          )}
        </div>
        <div className="btray">
          <button type="button" className="btray-tab" aria-expanded={benchOpen} aria-controls="offmap-panel" onClick={() => setBenchOpen((o) => !o)}>Archive</button>
          <span className="bchips">
            {chip(nF, 'file', 'files', 'var(--c-lecture)')}
            {chip(archivedNodes.length, 'off the map', 'off the map', 'var(--c-quiz)')}
          </span>
        </div>
      </aside>}

      {/* the Archive, student flavour: where Athena's notes go when removed
          from the map. Same tab-and-bin shell as the professor bench; each
          parked note can be restored or (only here) deleted for good. The tray
          only exists while something is in it — an empty archive is silence,
          not a control. */}
      {audience === 'stu' && archivedArtifacts.length > 0 && <aside className="bench">
        <div className="bpanel" id="offmap-panel">
          <div className="blabel">ARCHIVED NOTES FROM ATHENA</div>
          {/* cards keyed on the tray's open state ON PURPOSE: toggling the
              tray remounts them, which is what disarms a pending Delete
              confirm (see ArchivedNoteCard's header comment) */}
          <div className="brow">
            {archivedArtifacts.map((a) => (
              <ArchivedNoteCard key={`${a.id}:${benchOpen}`} a={a} onArchive={onArchiveArtifact} onDelete={onDeleteArtifact} />
            ))}
          </div>
        </div>
        <div className="btray">
          <button type="button" className="btray-tab" aria-expanded={benchOpen} aria-controls="offmap-panel" onClick={() => setBenchOpen((o) => !o)}>Archive</button>
          <span className="bchips">
            {chip(archivedArtifacts.length, 'note', 'notes', 'var(--c-athena)')}
          </span>
        </div>
      </aside>}
    </div>
    </JourneyOverlayContext.Provider>
  )
}
