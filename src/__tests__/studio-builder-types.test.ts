/**
 * Type-level guarantee, enforced by `npm run typecheck`: what a builder slice acts as can
 * never be handed to an operation that takes the section's professor (publish, install,
 * show to students). If the brands ever became compatible, the directive below would
 * stop being needed and typecheck would fail on it.
 */
import { describe, expect, it } from 'vitest'
import type { StudioBuilderActor, StudioProfessor } from '@/lib/studio/context'

function takesProfessor(p: StudioProfessor): string {
  return p.userId
}

describe('the builder actor', () => {
  it('is not a StudioProfessor', () => {
    const actor = { ownerId: 'o', sectionId: 's', institutionId: 'i', projectId: 'p' } as unknown as StudioBuilderActor
    // @ts-expect-error A builder actor is not the section's professor.
    const call = () => takesProfessor(actor)
    expect(typeof call).toBe('function')
  })
})
