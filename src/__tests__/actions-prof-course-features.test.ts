// Tests for the course sidebar actions. The security-relevant contract is that
// `settings.enabledFeatures` — which gates what STUDENTS can see and reach — is
// only ever written when publishing is genuinely intended.
//
// The regression that motivated this file: `reorderCourseFeatures` used to write
// its ordered key array into `enabledFeatures`. Once the professor sidebar began
// listing every feature, a single drag would have published all of them to
// students. It now writes `sidebarOrder`.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/discussion/default-channel', () => ({
  ensureDefaultCourseChannel: vi.fn(async () => {}),
}))

const SECTION = 'sec-1'
const OWNER = 'prof-1'

/** Admin client stub that serves `settings` and captures what gets written.
 *
 *  These actions no longer read settings and write the whole blob back; they send
 *  a key-scoped patch to the merge_course_section_settings RPC, which does the
 *  shallow merge inside one UPDATE. So `captured.payload` is now the PATCH, and
 *  the interesting assertion flipped: instead of checking that a rewritten blob
 *  happened to preserve the other keys, each test now checks the patch never
 *  NAMES a key this action doesn't own. That is the stronger property — a key
 *  absent from the patch cannot be clobbered by a concurrent writer at all. */
function stubAdmin(settings: Record<string, unknown>, professorId = OWNER) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captured: { payload?: any } = {}
  const admin = {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({ data: { id: SECTION, professor_id: professorId, settings }, error: null }),
        }),
      }),
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: vi.fn((fn: string, args: any) => {
      if (fn !== 'merge_course_section_settings') throw new Error(`unexpected rpc: ${fn}`)
      expect(args.p_section_id).toBe(SECTION)
      captured.payload = { settings: args.p_patch }
      return Promise.resolve({ error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return captured
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let actions: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  actions = await import('@/app/(dashboard)/professor/courses/[sectionId]/actions')
  mockGetUser.mockResolvedValue({ data: { user: { id: OWNER } }, error: null })
})

describe('reorderCourseFeatures', () => {
  it('writes sidebarOrder and leaves student visibility byte-identical', async () => {
    const captured = stubAdmin({ enabledFeatures: ['assignments'], about: { blocks: [] } })

    const res = await actions.reorderCourseFeatures(SECTION, ['settings', 'modules', 'quizzes'])

    expect(res.success).toBe(true)
    expect(captured.payload.settings.sidebarOrder).toEqual(['settings', 'modules', 'quizzes'])
    /* The whole point: dragging must not publish anything, and must not be able
       to disturb the About page either. The patch NAMES only sidebarOrder, so
       neither key is reachable from this write — a stronger statement than the
       old "we rewrote the blob and happened to copy them across". */
    expect(Object.keys(captured.payload.settings)).toEqual(['sidebarOrder'])
  })

  it('drops unknown keys and dedupes before persisting', async () => {
    const captured = stubAdmin({})
    await actions.reorderCourseFeatures(SECTION, ['modules', 'not-a-feature', 'modules', 'quizzes'])
    expect(captured.payload.settings.sidebarOrder).toEqual(['modules', 'quizzes'])
  })

  it('refuses a caller who does not own the section, without writing', async () => {
    const captured = stubAdmin({ enabledFeatures: [] }, 'someone-else')
    const res = await actions.reorderCourseFeatures(SECTION, ['modules'])
    expect(res.error).toBe('You do not own this course section')
    expect(captured.payload).toBeUndefined()
  })
})

describe('setCourseSidebarVisibility', () => {
  it('hiding removes the feature from the professor nav AND unpublishes it', async () => {
    // A feature left live for students that the professor can no longer reach
    // would strand work they cannot grade.
    const captured = stubAdmin({ enabledFeatures: ['quizzes', 'assignments'], customization: { css: '' } })

    const res = await actions.setCourseSidebarVisibility(SECTION, 'quizzes', false)

    expect(res.success).toBe(true)
    expect(captured.payload.settings.sidebarHidden).toEqual(['quizzes'])
    expect(captured.payload.settings.enabledFeatures).toEqual(['assignments'])
    // Unrelated namespaces are not named by the patch, so they cannot be touched.
    expect(Object.keys(captured.payload.settings).sort()).toEqual(['enabledFeatures', 'sidebarHidden'])
  })

  it('restoring un-hides WITHOUT publishing to students', async () => {
    // Draft-by-default is the point of the feature: bringing a hidden feature
    // back must not put it in front of students in the same click.
    const captured = stubAdmin({ enabledFeatures: [], sidebarHidden: ['quizzes', 'projects'] })

    await actions.setCourseSidebarVisibility(SECTION, 'quizzes', true)

    expect(captured.payload.settings.sidebarHidden).toEqual(['projects'])
    /* Draft-by-default, expressed as absence: un-hiding patches sidebarHidden and
       nothing else, so this click cannot publish to students even in principle. */
    expect(Object.keys(captured.payload.settings)).toEqual(['sidebarHidden'])
  })

  it('rejects a feature key that is not in the registry', async () => {
    const captured = stubAdmin({})
    const res = await actions.setCourseSidebarVisibility(SECTION, 'x'.repeat(5000), false)
    expect(res.error).toBe('Unknown feature')
    expect(captured.payload).toBeUndefined()
  })

  it('rejects an unauthenticated caller before touching the database', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } })
    const res = await actions.setCourseSidebarVisibility(SECTION, 'quizzes', false)
    expect(res.error).toBe('Not authenticated')
    expect(mockAdminClient).not.toHaveBeenCalled()
  })
})

describe('toggleCourseFeature', () => {
  it('publishing also restores the feature to the professor sidebar', async () => {
    const captured = stubAdmin({ enabledFeatures: [], sidebarHidden: ['quizzes'] })

    await actions.toggleCourseFeature(SECTION, 'quizzes', true)

    expect(captured.payload.settings.enabledFeatures).toEqual(['quizzes'])
    expect(captured.payload.settings.sidebarHidden).toEqual([])
  })

  it('refuses to publish a professor-only tool — it has no student side', async () => {
    // The popover routes professorOnly rows to setCourseSidebarVisibility; a
    // crafted call must not park 'settings' in the student-visibility list.
    const captured = stubAdmin({ enabledFeatures: [] })
    const res = await actions.toggleCourseFeature(SECTION, 'settings', true)
    expect(res.error).toBe('Unknown feature')
    expect(captured.payload).toBeUndefined()
  })

  it('unpublishing leaves the feature in the professor sidebar (draft state)', async () => {
    const captured = stubAdmin({ enabledFeatures: ['quizzes'], sidebarHidden: [] })

    await actions.toggleCourseFeature(SECTION, 'quizzes', false)

    expect(captured.payload.settings.enabledFeatures).toEqual([])
    /* Must NOT start hiding things — unpublish and hide are different actions.
       The patch simply does not name sidebarHidden, which is how "leave it
       alone" is now expressed. */
    expect(Object.keys(captured.payload.settings)).toEqual(['enabledFeatures'])
  })
})
