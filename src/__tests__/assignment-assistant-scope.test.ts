// resolveStudioConversationScope is the ONE mapping both the route (what a
// turn is WRITTEN under) and the panel (what the resume dropdown LISTS) call —
// see the comment on the function itself. A wrong case here doesn't error, it
// just silently misfiles or "loses" a thread: an assignment chat scoped like
// About's (no item id) would list under About's history instead, and an About
// chat scoped like an assignment's would need an assignmentId it doesn't have
// and vanish from every list.
import { describe, it, expect } from 'vitest'
import { resolveStudioConversationScope } from '@/lib/ai/assignment-assistant/schemas'

describe('resolveStudioConversationScope', () => {
  it('scopes an assignment authoring kind (files/notebook/verbal/document) by assignment_id', () => {
    expect(
      resolveStudioConversationScope({ surface: 'authoring', kind: 'files', assignmentId: 'asg-1' }),
    ).toEqual({ studioSurface: 'authoring', studioKind: 'files', assignmentId: 'asg-1', quizId: null, projectId: null })
  })

  it('scopes a quiz by quiz_id, never assignment_id', () => {
    expect(
      resolveStudioConversationScope({ surface: 'authoring', kind: 'quiz', assignmentId: 'quiz-1' }),
    ).toEqual({ studioSurface: 'authoring', studioKind: 'quiz', assignmentId: null, quizId: 'quiz-1', projectId: null })
  })

  it('scopes About with no item at all, even though the client sends no assignmentId anyway', () => {
    expect(
      resolveStudioConversationScope({ surface: 'authoring', kind: 'about', assignmentId: undefined }),
    ).toEqual({ studioSurface: 'authoring', studioKind: 'about', assignmentId: null, quizId: null, projectId: null })
  })

  it('routes the grade surface to studio_surface=grade, scoped by assignment_id (never a kind)', () => {
    expect(
      resolveStudioConversationScope({ surface: 'grade', kind: undefined, assignmentId: 'asg-9' }),
    ).toEqual({ studioSurface: 'grade', studioKind: null, assignmentId: 'asg-9', quizId: null, projectId: null })
  })

  it('scopes a project by project_id, never assignment_id', () => {
    // A project rides the same assignmentId slot the Quiz Studio overloads. Writing it
    // into assignment_id instead would fail that column's assignments(id) foreign key
    // and 500 the first turn, so this mapping is load-bearing, not cosmetic.
    expect(
      resolveStudioConversationScope({ surface: 'authoring', kind: 'project', assignmentId: 'proj-1' }),
    ).toEqual({
      studioSurface: 'authoring', studioKind: 'project',
      assignmentId: null, quizId: null, projectId: 'proj-1',
    })
  })

  it('falls to the no-host general scope when nothing is registered (a list page)', () => {
    expect(
      resolveStudioConversationScope({ surface: 'authoring', kind: undefined, assignmentId: undefined }),
    ).toEqual({ studioSurface: 'general', studioKind: null, assignmentId: null, quizId: null, projectId: null })
  })
})
