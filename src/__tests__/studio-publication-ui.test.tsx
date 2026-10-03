/**
 * The professor's publication UI, the Studio kill switch card, course assistants' Studio
 * page and students' past tools, in jsdom. The components only display what the server
 * decided and call actions; the actions and services are tested on their own. Here we
 * check that a blocked plugin can't be confirmed, that warnings need acknowledging, and
 * that nothing destructive runs without a confirmation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { parseManifest } from '@/lib/studio/manifest'
import { buildPluginCard } from '@/lib/studio/plugin-card'

const refresh = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push, replace: vi.fn(), back: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions', () => ({
  showToStudentsAction: vi.fn(),
  hideFromStudentsAction: vi.fn(),
  archiveInstallationAction: vi.fn(),
  requestRuntimeChecksAction: vi.fn(),
  bindSkillSlotAction: vi.fn(),
}))
vi.mock('@/app/(dashboard)/super-admin/ai-controls/studio-actions', () => ({ setStudioKillSwitch: vi.fn() }))

const actions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions')
const { setStudioKillSwitch } = await import('@/app/(dashboard)/super-admin/ai-controls/studio-actions')
const { PublicationDialog } = await import('@/components/studio/publication/PublicationDialog')
const { PublicationControls } = await import('@/components/studio/publication/PublicationControls')
const { VersionPreviewPicker } = await import('@/components/studio/publication/VersionPreviewPicker')
const { StudioKillSwitchCard } = await import('@/components/super-admin/StudioKillSwitchCard')
const { StudioLanding } = await import('@/components/studio/StudioLanding')
const { StudentPastTools } = await import('@/components/student/courses/StudentPastTools')
const { ValidationChecks } = await import('@/components/studio/publication/ValidationChecks')
const { toast } = await import('sonner')

const parsed = parseManifest(exitTicket)
if (!parsed.ok) throw new Error('fixture manifest is invalid')
const card = buildPluginCard(parsed.manifest, null)
const SECTION = 's1'
const INSTALLATION = 'i1'
const VALIDATOR = { code: 'validator_unavailable' as const, message: 'Automatic checks for student use aren’t available yet.' }
const GATE = { code: 'release_gate' as const, message: 'Showing tools to students isn’t available yet.' }
const FULL = { code: 'over_quota' as const, message: 'This tool’s storage is full.' }
const NEAR_QUOTA = { code: 'near_quota' as const, message: 'This plugin has used most of its storage.' }

function dialog(blockers: { code: 'validator_unavailable' | 'release_gate' | 'over_quota'; message: string }[] = [VALIDATOR], warnings: (typeof NEAR_QUOTA)[] = []) {
  return render(
    <PublicationDialog
      open
      onOpenChange={() => {}}
      sectionId={SECTION}
      installationId={INSTALLATION}
      card={card}
      blockers={blockers}
      warnings={warnings}
    />,
  )
}

const showButton = () => screen.getByRole('button', { name: 'Show to students' })

beforeEach(() => vi.clearAllMocks())

describe('the publication dialog', () => {
  it('shows the plugin card: what students and the professor can do, data, AI, grading', () => {
    dialog([])
    expect(screen.getByRole('heading', { name: `Show ${card.name} to students?` })).toBeInTheDocument()
    expect(screen.getByText('Save their own responses')).toBeInTheDocument()
    expect(screen.getByText('Read every student’s responses')).toBeInTheDocument()
    expect(screen.getByText(card.ai)).toBeInTheDocument()
    expect(screen.getByText(card.grading)).toBeInTheDocument()
  })

  it('while blocked, the card can still be read, and there is no way to confirm', () => {
    dialog()
    expect(screen.getByRole('heading', { name: `${card.name} can’t be shown to students yet` })).toBeInTheDocument()
    expect(screen.getByText('Not ready for students yet')).toBeInTheDocument()
    expect(screen.getByText(VALIDATOR.message)).toBeInTheDocument()
    expect(screen.getByText('Save their own responses')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show to students' })).toBeNull()
    // The footer's Close, besides the dialog's own close icon.
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThanOrEqual(1)
    expect(actions.showToStudentsAction).not.toHaveBeenCalled()
  })

  it('says each reason once: the release gate already covers the missing checks', () => {
    dialog([GATE, VALIDATOR])
    expect(screen.getByText(GATE.message)).toBeInTheDocument()
    expect(screen.queryByText(VALIDATOR.message)).toBeNull()
  })

  it('a problem with the tool itself is shown as one to fix, not as "not yet"', () => {
    dialog([FULL])
    expect(screen.getByText('Fix these first')).toBeInTheDocument()
    expect(screen.queryByText('Not ready for students yet')).toBeNull()
  })

  it('with blockers, warnings can’t be acknowledged at all', () => {
    dialog([VALIDATOR], [NEAR_QUOTA])
    expect(screen.getByText(NEAR_QUOTA.message)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show to students' })).toBeNull()
  })

  it('with only warnings, the professor must acknowledge them first', async () => {
    vi.mocked(actions.showToStudentsAction).mockResolvedValue({ success: true })
    dialog([], [NEAR_QUOTA])
    expect(showButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /I’ve read these/ }))
    expect(showButton()).toBeEnabled()
    fireEvent.click(showButton())
    await waitFor(() => expect(actions.showToStudentsAction).toHaveBeenCalledWith(SECTION, INSTALLATION, true))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('fresh page data clears blockers resolved inside the dialog, so the professor can confirm without reopening', () => {
    const SLOT = { code: 'skill_binding_missing' as const, message: 'Link each skill slot to one of this course’s skills: Topic.' }
    const props = { open: true, onOpenChange: () => {}, sectionId: SECTION, installationId: INSTALLATION, card, warnings: [] }
    const { rerender } = render(<PublicationDialog {...props} blockers={[SLOT]} />)
    expect(screen.getByText('Not ready for students yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show to students' })).toBeNull()
    // router.refresh() after binding the slot sends new props.
    rerender(<PublicationDialog {...props} blockers={[]} />)
    expect(showButton()).toBeEnabled()
  })

  it('when the server refuses on submit, its blockers replace the old ones and confirming goes away', async () => {
    vi.mocked(actions.showToStudentsAction).mockResolvedValue({ error: VALIDATOR.message, blockers: [VALIDATOR], warnings: [] })
    dialog([], [])
    fireEvent.click(showButton())
    await waitFor(() => expect(screen.getByText('Not ready for students yet')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Show to students' })).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('new warnings from the server must be acknowledged again', async () => {
    const NEWER = { code: 'newer_version' as const, message: 'A newer version of this tool is published.' }
    vi.mocked(actions.showToStudentsAction).mockResolvedValue({ error: 'Read the warnings first.', warnings: [NEAR_QUOTA, NEWER] })
    dialog([], [NEAR_QUOTA])
    fireEvent.click(screen.getByRole('checkbox', { name: /I’ve read these/ }))
    fireEvent.click(showButton())
    await waitFor(() => expect(screen.getByText(NEWER.message)).toBeInTheDocument())
    expect(screen.getByRole('checkbox', { name: /I’ve read these/ })).not.toBeChecked()
    // The button reads "Showing…" until the transition settles.
    await waitFor(() => expect(showButton()).toBeDisabled())
  })
})

describe('publication controls', () => {
  const controls = (props: Partial<Parameters<typeof PublicationControls>[0]> = {}) =>
    render(
      <PublicationControls
        sectionId={SECTION}
        installationId={INSTALLATION}
        status="active"
        visibility="hidden"
        card={card}
        blockers={[VALIDATOR]}
        warnings={[]}
        validation={null}
        skillSlots={[]}
        sectionSkills={[]}
        {...props}
      />,
    )

  it('a hidden tool says so and offers to show it, which opens the card, not the action', () => {
    controls()
    expect(screen.getByText('Hidden from students')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show to students…' }))
    expect(screen.getByRole('heading', { name: `${card.name} can’t be shown to students yet` })).toBeInTheDocument()
    expect(actions.showToStudentsAction).not.toHaveBeenCalled()
  })

  it('while previewing another version, there is no "Show to students": it would act on the active one', () => {
    controls({ previewingOtherVersion: true })
    expect(screen.queryByRole('button', { name: 'Show to students…' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove from course' })).toBeInTheDocument()
  })

  it('a visible tool says so; hiding it waits for a confirmation', async () => {
    vi.mocked(actions.hideFromStudentsAction).mockResolvedValue({ success: true })
    controls({ visibility: 'visible' })
    expect(screen.getByText('Visible to students')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide from students' }))
    expect(actions.hideFromStudentsAction).not.toHaveBeenCalled()
    const confirm = screen.getByRole('alertdialog')
    expect(within(confirm).getByText(/saved work is kept/)).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Hide from students' }))
    await waitFor(() => expect(actions.hideFromStudentsAction).toHaveBeenCalledWith(SECTION, INSTALLATION))
  })

  it('removing from the course waits for a confirmation that says data is kept and it can’t come back', async () => {
    vi.mocked(actions.archiveInstallationAction).mockResolvedValue({ success: true })
    controls()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from course' }))
    const confirm = screen.getByRole('alertdialog')
    expect(within(confirm).getByText(/stays readable, but the tool can’t be changed or shown to students again/)).toBeInTheDocument()
    expect(actions.archiveInstallationAction).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(actions.archiveInstallationAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove from course' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove from course' }))
    await waitFor(() => expect(actions.archiveInstallationAction).toHaveBeenCalledWith(SECTION, INSTALLATION))
  })

  it('a removed tool shows only that, with no controls', () => {
    controls({ status: 'archived', visibility: 'visible' })
    expect(screen.getByText('Removed from course')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('the version preview picker', () => {
  it('isn’t shown when there is no other version', () => {
    const { container } = render(
      <VersionPreviewPicker basePath="/p" versions={[{ id: 'v1', version: '1.0.0' }]} activeVersionId="v1" view="professor" />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('is labelled, and calls no action: previewing only navigates', () => {
    render(
      <VersionPreviewPicker
        basePath="/p"
        versions={[
          { id: 'v2', version: '1.1.0' },
          { id: 'v1', version: '1.0.0' },
        ]}
        activeVersionId="v1"
        view="student"
      />,
    )
    expect(screen.getByLabelText('Preview version')).toBeInTheDocument()
    expect(actions.showToStudentsAction).not.toHaveBeenCalled()
    expect(actions.archiveInstallationAction).not.toHaveBeenCalled()
  })
})

describe('the Studio kill switch card', () => {
  it('running: offers to pause, and only after a confirmation', async () => {
    vi.mocked(setStudioKillSwitch).mockResolvedValue({ success: true })
    render(<StudioKillSwitchCard state="running" />)
    expect(screen.getByText('Studio is running.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pause Studio everywhere' }))
    expect(setStudioKillSwitch).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pause Studio' }))
    await waitFor(() => expect(setStudioKillSwitch).toHaveBeenCalledWith(true))
  })

  it('paused: offers to turn it back on', async () => {
    vi.mocked(setStudioKillSwitch).mockResolvedValue({ success: true })
    render(<StudioKillSwitchCard state="engaged" />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn Studio back on' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(setStudioKillSwitch).toHaveBeenCalledWith(false))
  })

  it('unreadable: says Studio is treated as paused, and only offers to pause', () => {
    render(<StudioKillSwitchCard state="unknown" />)
    expect(screen.getByText(/treated as paused/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn Studio back on' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Pause Studio everywhere' })).toBeInTheDocument()
  })
})

describe('course assistants’ Studio page', () => {
  it('doesn’t say nothing is built when tools exist', () => {
    render(<StudioLanding toolCount={2} />)
    expect(screen.getByText('This course has 2 tools')).toBeInTheDocument()
    expect(screen.queryByText(/Nothing built/)).toBeNull()
  })

  it('says nothing is built only when nothing is', () => {
    render(<StudioLanding toolCount={0} />)
    expect(screen.getByText('Nothing built for this course yet')).toBeInTheDocument()
  })
})

describe('students’ past tools', () => {
  it('lists each tool as read-only, linking to its page', () => {
    render(<StudentPastTools sectionId={SECTION} tools={[{ installationId: 'i9', name: 'Exit ticket', hiddenFromStudents: false }]} />)
    expect(screen.getByRole('heading', { name: 'Past tools' })).toBeInTheDocument()
    expect(screen.getByText(/can’t add to it/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Exit ticket/ })).toHaveAttribute('href', `/student/courses/${SECTION}/tools/i9`)
    expect(screen.getByText('Read-only')).toBeInTheDocument()
  })

  it('renders nothing when there are none', () => {
    const { container } = render(<StudentPastTools sectionId={SECTION} tools={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('Studio’s automatic checks in the card', () => {
  type Summary = NonNullable<Parameters<typeof ValidationChecks>[0]['validation']>
  const summary = (change: Partial<Summary> = {}): Summary => ({
    verdict: { status: 'unavailable', reason: 'runtime_not_checked' },
    stages: { static: { status: 'passed', findings: [] }, runtime: null },
    canRequestRuntime: true,
    runnerAvailable: true,
    ...change,
  })
  const checks = (validation: Summary | null) =>
    render(<ValidationChecks sectionId={SECTION} installationId={INSTALLATION} validation={validation} />)

  it('starts the browser checks for this installation, then refreshes', async () => {
    vi.mocked(actions.requestRuntimeChecksAction).mockResolvedValue({ success: true })
    checks(summary())
    fireEvent.click(screen.getByRole('button', { name: 'Run browser checks' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(actions.requestRuntimeChecksAction).toHaveBeenCalledWith(SECTION, INSTALLATION)
  })

  it('shows the server’s refusal and does not refresh', async () => {
    vi.mocked(actions.requestRuntimeChecksAction).mockResolvedValue({ error: 'Browser checks can’t run here.' })
    checks(summary())
    fireEvent.click(screen.getByRole('button', { name: 'Run browser checks' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Browser checks can’t run here.'))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('re-reads the page while a check runs, and stops once nothing is running', () => {
    vi.useFakeTimers()
    try {
      const running = summary({ stages: { static: { status: 'passed', findings: [] }, runtime: { status: 'running', findings: [] } } })
      const { rerender } = checks(running)
      expect(screen.getByText(/can take a few minutes/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Run browser checks' })).toBeNull()
      vi.advanceTimersByTime(5000)
      expect(refresh).toHaveBeenCalledTimes(1)
      rerender(<ValidationChecks sectionId={SECTION} installationId={INSTALLATION} validation={summary({ stages: { static: { status: 'passed', findings: [] }, runtime: { status: 'passed', findings: [] } } })} />)
      vi.advanceTimersByTime(20_000)
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers to run the checks again after one couldn’t finish', () => {
    checks(summary({ verdict: { status: 'unavailable', reason: 'runtime_error' }, stages: { static: { status: 'passed', findings: [] }, runtime: { status: 'error', findings: [] } } }))
    expect(screen.getByRole('button', { name: 'Run the checks again' })).toBeInTheDocument()
  })

  it('says plainly when no runner exists, and offers no button', () => {
    checks(summary({ runnerAvailable: false }))
    expect(screen.getByText(/Browser checks aren’t available yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run browser checks' })).toBeNull()
  })

  it('lists findings with what kind each is', () => {
    checks(
      summary({
        verdict: { status: 'needs_review', runId: 'r', checkIds: ['data.answer_key'] },
        stages: { static: { status: 'needs_review', findings: [{ checkId: 'data.answer_key', status: 'needs_review', message: 'Answers may be visible to students.', review: null }] }, runtime: null },
      }),
    )
    expect(screen.getByText('Answers may be visible to students.')).toBeInTheDocument()
    expect(screen.getByText('Needs a reviewer:')).toBeInTheDocument()
  })

  it('without a summary, says the checks couldn’t load rather than implying they passed', () => {
    checks(null)
    expect(screen.getByText(/Couldn’t load the checks just now/)).toBeInTheDocument()
  })
})
