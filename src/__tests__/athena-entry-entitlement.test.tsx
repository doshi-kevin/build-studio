/**
 * The Athena entry points a professor can CLICK, gated on whether the school
 * bought Athena.
 *
 * `assistant/page.tsx` now calls verifyEntitled, so for an unentitled school
 * that route is a 404. Every in-flow link pointing at it therefore has to
 * disappear at the same time, or the professor is invited into a dead end —
 * the exact bug `.claude/rules/dead-ends.md` exists to stop, and the one the
 * entitlement call-site test already records browser QA catching once on the
 * course sidebars.
 *
 * Three surfaces read the same `entitled` flag off the dock:
 *   - AssignmentStudioEntry — the pill and the inline "Athena can guide you".
 *   - AthenaAskLine — renders nothing at all.
 *   - SupportingFilesStep — its rubric caption drops the "(or ask Athena)" clause.
 *
 * The last one is copy, not a link, and it is here for the same reason the
 * chooser-copy case below is: naming Athena as a way to get the job done is an
 * offer, and the page behind the offer 404s for an unentitled school.
 *
 * The provider is REAL here on purpose. `useAthenaDock` falls back to
 * `entitled: true` when no provider is mounted, so a test that stubbed the
 * hook would still pass if the prop stopped flowing through the context.
 * Mounting the real provider is what proves the flag actually arrives.
 * Only the chat SDK and the server actions are stubbed, mirroring
 * athena-ask-line.test.tsx.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  AssignmentAthenaProvider,
  useAthenaSurface,
} from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { AssignmentStudioEntry } from '@/components/professor/assignments/AssignmentStudioEntry'
import { SupportingFilesStep } from '@/components/professor/assignments/studio/shared/SupportingFilesStep'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    setMessages: vi.fn(),
    sendMessage: vi.fn(),
    addToolResult: vi.fn(),
    status: 'ready',
    error: undefined,
    stop: vi.fn(),
  }),
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('@/components/professor/assignments/athena/actions', () => ({
  // The panel reads its rate-limit pool on open; unmocked this reaches the real
  // server action → createClient() → cookies(), which throws in jsdom.
  getPanelAthenaUsage: async () => ({ status: { models: [], resets_at: null } }),
  saveAssignmentDesign: vi.fn(),
  applyFrontierRubric: vi.fn(),
}))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions', () => ({
  uploadAssignmentAttachment: vi.fn(),
  createNotebookAssignment: vi.fn(),
  setTemplateSaved: vi.fn(),
  // SupportingFilesStep and its two real children (AssignmentModuleTags, RubricEditor)
  // all call into this module; only getAssignmentSkillTagging fires on mount.
  getAssignmentSkillTagging: async () => ({ modules: [], taggedIds: [], skillOptions: [] }),
  saveAssignmentSkillModules: vi.fn(),
  saveAssignmentInstructions: vi.fn(),
  uploadAssignmentPdf: vi.fn(),
  removeAssignmentPdf: vi.fn(),
  generateAssignmentRubric: vi.fn(),
  saveAssignmentRubric: vi.fn(),
  saveAssignmentRubricDraft: vi.fn(),
  discardAssignmentRubricDraft: vi.fn(),
  uploadRubricSourcePdf: vi.fn(),
}))

Element.prototype.scrollIntoView = vi.fn()

const SECTION = 'sec-1'
const ASSISTANT_URL = `/professor/courses/${SECTION}/assistant`

/** Every rendered link that would navigate the professor to the Athena page. */
const assistantLinks = () =>
  screen.queryAllByRole('link').filter((a) => a.getAttribute('href') === ASSISTANT_URL)

const renderStudioEntry = (entitled: boolean) =>
  render(
    <AssignmentAthenaProvider sectionId={SECTION} entitled={entitled}>
      <AssignmentStudioEntry sectionId={SECTION} />
    </AssignmentAthenaProvider>,
  )

/** The studios' shared "Add files & rubrics" step, children rendered for real. */
const renderSupportingFiles = (entitled: boolean) =>
  render(
    <AssignmentAthenaProvider sectionId={SECTION} entitled={entitled}>
      <SupportingFilesStep
        sectionId={SECTION}
        assignmentId="a1"
        contentKind="notebook"
        initialDescription=""
        initialPdfs={[]}
        initialRubricSources={[]}
        initialRubric={null}
        initialPoints={100}
        onRubricSaved={() => {}}
      />
    </AssignmentAthenaProvider>,
  )

describe('Athena entry points respect the institution entitlement', () => {
  it('offers both Athena routes into the assistant when the school has it', () => {
    renderStudioEntry(true)

    // The pill and the inline sentence link are two separate entry points; a
    // regression that drops one while keeping the other is still a regression.
    expect(assistantLinks()).toHaveLength(2)
    expect(screen.getByRole('link', { name: /Athena can guide you/ })).toBeInTheDocument()
  })

  it('renders NO route to the assistant page when the school does not have Athena', () => {
    renderStudioEntry(false)

    // The page itself now notFound()s, so any surviving link is a dead end.
    expect(assistantLinks()).toHaveLength(0)
    expect(screen.queryByRole('link', { name: /Athena can guide you/ })).toBeNull()
  })

  it('keeps the chooser copy honest instead of dangling a broken offer', () => {
    // The fallback is not cosmetic: the entitled copy ends "...or Athena can
    // guide you.", which reads as a promise the 404 would then break.
    renderStudioEntry(false)
    expect(screen.getByText(/Pick how students will work\./)).toBeInTheDocument()
    expect(screen.queryByText(/Athena can guide you/)).toBeNull()

    renderStudioEntry(true)
    expect(screen.getByText(/Athena can guide you/)).toBeInTheDocument()
  })

  it('renders the floating ask line only for an entitled school', () => {
    // Pre-existing `if (!entitled) return null` in AthenaAskLine, uncovered
    // until now — it is the other half of the same gate.
    function Host() {
      useAthenaSurface({
        active: true,
        surface: 'authoring',
        kind: 'quiz',
        assignmentId: 'a1',
        getScreen: () => ({}),
        onFill: () => ({ summary: 'ok', applied: true }),
      })
      return <AthenaAskLine />
    }

    const { unmount } = render(
      <AssignmentAthenaProvider sectionId={SECTION} entitled={false}>
        <Host />
      </AssignmentAthenaProvider>,
    )
    expect(screen.queryByLabelText('Ask Athena')).toBeNull()
    unmount()

    render(
      <AssignmentAthenaProvider sectionId={SECTION} entitled>
        <Host />
      </AssignmentAthenaProvider>,
    )
    expect(screen.getByLabelText('Ask Athena')).toBeInTheDocument()
  })

  it('names Athena in the rubric caption only when the school has it', () => {
    // The caption's non-Athena half has to survive the cut — a ternary that
    // swallowed the whole sentence would leave the professor with no
    // instruction for Generate rubric at all.
    const caption = /Draft one with Generate rubric/

    const { unmount } = renderSupportingFiles(false)
    expect(screen.getByText(caption)).toBeInTheDocument()
    expect(screen.queryByText(/ask Athena/)).toBeNull()
    unmount()

    renderSupportingFiles(true)
    expect(screen.getByText(caption)).toBeInTheDocument()
    expect(screen.getByText(/or ask Athena/)).toBeInTheDocument()
  })
})
