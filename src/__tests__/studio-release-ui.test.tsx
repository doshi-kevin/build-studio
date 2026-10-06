/**
 * The Step 10 release surfaces, in jsdom: the Save card's next step, switching or rolling
 * back a version on the tool page, the unreleased-material warning, a reviewer's decision
 * in the professor's checks, and the super admin's review queue and validator card. The
 * components only show what the server decided and call actions; those are tested on
 * their own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GOOD_MANIFEST } from '@/lib/studio/validator/fixtures'
import { parseManifest } from '@/lib/studio/manifest'
import { buildPluginCard } from '@/lib/studio/plugin-card'
import type { ReviewQueueView } from '@/lib/studio/validator/service'

const refresh = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push, replace: vi.fn(), back: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions', () => ({ versionReleaseAction: vi.fn(), addVersionToCourseAction: vi.fn() }))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions', () => ({
  switchVersionAction: vi.fn(),
  requestRuntimeChecksAction: vi.fn(),
  showToStudentsAction: vi.fn(),
  hideFromStudentsAction: vi.fn(),
  archiveInstallationAction: vi.fn(),
  bindSkillSlotAction: vi.fn(),
}))
vi.mock('@/app/(dashboard)/super-admin/studio-reviews/actions', () => ({ resolveReviewAction: vi.fn() }))
vi.mock('@/app/(dashboard)/super-admin/ai-controls/studio-actions', () => ({ raiseValidatorRuleset: vi.fn() }))

const builderActions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/actions')
const toolActions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions')
const { resolveReviewAction } = await import('@/app/(dashboard)/super-admin/studio-reviews/actions')
const { raiseValidatorRuleset } = await import('@/app/(dashboard)/super-admin/ai-controls/studio-actions')
const { SaveReleaseCard } = await import('@/components/studio/builder/SaveReleaseCard')
const { UseVersionPanel } = await import('@/components/studio/publication/UseVersionPanel')
const { IssueWarnings } = await import('@/components/studio/publication/IssueWarnings')
const { ValidationChecks } = await import('@/components/studio/publication/ValidationChecks')
const { StudioReviewQueue } = await import('@/components/super-admin/StudioReviewQueue')
const { StudioValidatorCard } = await import('@/components/super-admin/StudioValidatorCard')
const { StudioRuntimeView } = await import('@/components/studio/runtime/StudioRuntimeView')

const parsed = parseManifest(GOOD_MANIFEST)
if (!parsed.ok) throw new Error('fixture manifest is invalid')
const card = buildPluginCard(parsed.manifest, null)
const MATERIAL = {
  code: 'unreleased_material' as const,
  message: 'While building this version, Athena read course material students can’t see yet.',
  sources: [{ label: 'Week 6: Midterm review (slides)', opensAt: '2026-10-09T13:00:00Z', note: 'not visible to students yet' }],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the Save card’s next step', () => {
  it('a course without the tool: shows the card, adds it, and says the checks started', async () => {
    vi.mocked(builderActions.versionReleaseAction).mockResolvedValue({ success: true, mode: 'add', visible: false, installationId: null, card, added: [] })
    vi.mocked(builderActions.addVersionToCourseAction).mockResolvedValue({ success: true, installationId: 'i1', added: true, checks: 'Studio’s automatic checks are running.' })
    render(<SaveReleaseCard sectionId="s1" versionId="v1" version="1.0.0" />)
    expect(await screen.findByRole('heading', { name: 'Add Exit ticket to this course?' })).toBeInTheDocument()
    expect(screen.getByText(/starts hidden from students/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add to this course' }))
    expect(await screen.findByText(/Added to this course/)).toBeInTheDocument()
    expect(screen.getByText('Studio’s automatic checks are running.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the tool' })).toHaveAttribute('href', '/professor/courses/s1/studio/i1')
    expect(builderActions.addVersionToCourseAction).toHaveBeenCalledWith({ sectionId: 's1', versionId: 'v1', acknowledgeWarnings: false })
  })

  it('a version students would get at once: warns, lists what’s new, and needs the warning acknowledged', async () => {
    vi.mocked(builderActions.versionReleaseAction).mockResolvedValue({ success: true, mode: 'use', visible: true, installationId: 'i1', card, added: ['Saves responses: theirs.'] })
    vi.mocked(builderActions.addVersionToCourseAction)
      .mockResolvedValueOnce({ error: 'Read the warnings before students see this version.', warnings: [MATERIAL] })
      .mockResolvedValueOnce({ success: true, installationId: 'i1', added: false, checks: 'Running.' })
    render(<SaveReleaseCard sectionId="s1" versionId="v2" version="1.1.0" />)
    expect(await screen.findByText(/they get this version right away/)).toBeInTheDocument()
    expect(screen.getByText('Saves responses: theirs.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use this version in the course' }))
    expect(await screen.findByText(/Week 6: Midterm review \(slides\)/)).toBeInTheDocument()
    // The warnings can render a beat before the button leaves its pending label.
    const button = await screen.findByRole('button', { name: 'Use this version in the course' })
    expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(button)
    expect(await screen.findByText('Your course now uses version 1.1.0.')).toBeInTheDocument()
    expect(vi.mocked(builderActions.addVersionToCourseAction).mock.calls[1][0]).toMatchObject({ acknowledgeWarnings: true })
  })

  it('a blocker is listed, offers no button to push past it, and points to the tool page to finish later', async () => {
    vi.mocked(builderActions.versionReleaseAction).mockResolvedValue({ success: true, mode: 'use', visible: true, installationId: 'i1', card, added: [] })
    vi.mocked(builderActions.addVersionToCourseAction).mockResolvedValue({
      error: 'Students can see this tool, so this version has to clear the same checks as showing it.',
      blockers: [{ code: 'validator_unavailable', message: 'Studio’s automatic checks are still running.' }],
    })
    render(<SaveReleaseCard sectionId="s1" versionId="v2" version="1.1.0" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Use this version in the course' }))
    expect(await screen.findByText('Studio’s automatic checks are still running.', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('link', { name: 'Open the tool' })).toHaveAttribute('href', '/professor/courses/s1/studio/i1')
  })

  it('a version the course already uses offers nothing', async () => {
    vi.mocked(builderActions.versionReleaseAction).mockResolvedValue({ success: true, mode: 'current', visible: false, installationId: 'i1', card, added: [] })
    const { container } = render(<SaveReleaseCard sectionId="s1" versionId="v1" version="1.0.0" />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})

describe('switching or rolling back on the tool page', () => {
  const panel = (older: boolean) =>
    render(<UseVersionPanel sectionId="s1" installationId="i1" versionId="v0" version="0.9.0" older={older} visible added={[]} basePath="/professor/courses/s1/studio/i1" />)

  it('an older version is offered as a roll back, and success returns to the course’s version', async () => {
    vi.mocked(toolActions.switchVersionAction).mockResolvedValue({ success: true })
    panel(true)
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to v0.9.0' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/professor/courses/s1/studio/i1'))
    expect(toolActions.switchVersionAction).toHaveBeenCalledWith('s1', 'i1', 'v0', false)
  })

  it('an unacknowledged warning holds the switch', async () => {
    vi.mocked(toolActions.switchVersionAction).mockResolvedValue({ error: 'Read the warnings before students see this version.', warnings: [MATERIAL] })
    panel(false)
    fireEvent.click(screen.getByRole('button', { name: 'Use v0.9.0 in the course' }))
    expect(await screen.findByText(/Students can’t see this until/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use v0.9.0 in the course' })).toBeDisabled()
    expect(push).not.toHaveBeenCalled()
  })
})

describe('the unreleased-material warning', () => {
  it('names each source and when students can see it; undated material says so', () => {
    render(<IssueWarnings id="w" warnings={[{ ...MATERIAL, sources: [...MATERIAL.sources, { label: 'Hidden quiz key', opensAt: null, note: '' }] }]} />)
    expect(screen.getByText('Week 6: Midterm review (slides). Students can’t see this until Oct 9.')).toBeInTheDocument()
    expect(screen.getByText('Hidden quiz key. Students can’t see this.')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

describe('a reviewer’s decision in the professor’s checks', () => {
  it('shows who decided and their reason, as text', () => {
    render(
      <ValidationChecks
        sectionId="s1"
        installationId="i1"
        validation={{
          verdict: { status: 'failed', reason: 'review_rejected' },
          stages: {
            static: { status: 'failed', findings: [{ checkId: 'edtech.purpose', status: 'needs_review', message: 'Purpose unclear.', review: { decision: 'rejected', reason: '<b>Not a course tool.</b>' } }] },
            runtime: null,
          },
          canRequestRuntime: false,
          runnerAvailable: false,
        } as never}
      />,
    )
    expect(screen.getByText('Rejected by a Scholera reviewer:')).toBeInTheDocument()
    expect(screen.getByText('Reviewer’s note: <b>Not a course tool.</b>')).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
  })
})

describe('the super admin’s review queue', () => {
  const item: ReviewQueueView = {
    validationId: 'val-1', checkId: 'edtech.purpose', checkSummary: 'The tool is for teaching', message: 'Studio couldn’t tell.',
    findings: [{ view: 'student', detail: 'classifier unavailable' }], stage: 'static', recheck: false, waitingSince: '2026-10-01T12:00:00Z',
    institution: 'Test University', courses: ['BIO101: Biology'], pluginName: 'Exit ticket', version: '1.0.0', purpose: 'Reflection.', artifactSha256: 'a'.repeat(64),
    source: { view: 'student', text: '<script>alert(1)</script>' }, publishedByYou: false,
  }

  it('shows the flagged source as text, never markup, and names the school and course', () => {
    render(<StudioReviewQueue items={[item]} />)
    expect(screen.getByText(/Test University · BIO101: Biology/)).toBeInTheDocument()
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })

  it('a decision needs a reason, and is bound to the artifact the reviewer saw', async () => {
    vi.mocked(resolveReviewAction).mockResolvedValue({ success: true })
    render(<StudioReviewQueue items={[item]} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'A reflection tool.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(resolveReviewAction).toHaveBeenCalledWith({ validationId: 'val-1', checkId: 'edtech.purpose', artifactSha256: 'a'.repeat(64), decision: 'approved', reason: 'A reflection tool.' })
  })

  it('a version the reviewer published can’t be decided by them', () => {
    render(<StudioReviewQueue items={[{ ...item, publishedByYou: true }]} />)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText(/another reviewer has to decide/)).toBeInTheDocument()
  })

  it('an empty queue says so', () => {
    render(<StudioReviewQueue items={[]} />)
    expect(screen.getByText('Nothing to review')).toBeInTheDocument()
  })
})

describe('the Studio validator card', () => {
  const panel = { codeRuleset: 2, minAccepted: 1, revalidating: 0, waitingOnCapacity: 0, reviewsWaiting: 0 }

  it('raises only after a confirmation', async () => {
    vi.mocked(raiseValidatorRuleset).mockResolvedValue({ success: true, queued: 3 })
    render(<StudioValidatorCard panel={panel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept only version 2 checks' }))
    expect(raiseValidatorRuleset).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Raise and re-check' }))
    await waitFor(() => expect(raiseValidatorRuleset).toHaveBeenCalledTimes(1))
  })

  it('offers no raise once the minimum is the code’s, and shows re-checks waiting on capacity', () => {
    render(<StudioValidatorCard panel={{ ...panel, minAccepted: 2, revalidating: 4, waitingOnCapacity: 1 }} />)
    expect(screen.queryByRole('button', { name: /Accept only/ })).toBeNull()
    expect(screen.getByText(/4 \(1 waiting for browser-check capacity\)/)).toBeInTheDocument()
  })
})

describe('the tool page after the accepted checks were raised', () => {
  const view = (reason: 'below_minimum_ruleset' | 'runtime_not_checked', visibility: 'visible' | 'hidden') =>
    render(
      <StudioRuntimeView
        title="Exit ticket" view="professor" installationId="i1" versionId="v1" readOnly={false} sectionId="s1" frameUrl={null} allowedMethods={[]}
        versions={[{ id: 'v1', version: '1.0.0' }]} activeVersionId="v1"
        publication={{
          status: 'active', visibility, card, blockers: [], warnings: [], skillSlots: [], sectionSkills: [],
          validation: { verdict: { status: 'unavailable', reason }, stages: { static: null, runtime: null }, canRequestRuntime: false, runnerAvailable: false } as never,
        }}
      />,
    )

  it('says the tool is being re-checked, and that students keep it meanwhile', () => {
    view('below_minimum_ruleset', 'visible')
    expect(screen.getByRole('status')).toHaveTextContent('Studio’s checks were updated. This tool is being re-checked. Students can still use it in the meantime.')
  })

  it('says nothing for other reasons', () => {
    view('runtime_not_checked', 'hidden')
    expect(screen.queryByText(/being re-checked/)).toBeNull()
  })
})
