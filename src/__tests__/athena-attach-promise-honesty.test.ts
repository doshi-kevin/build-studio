/**
 * #652 — the attach confirmation must describe what actually happens.
 *
 * The original defect: the in-builder paperclip uploaded a student-facing file the
 * assistant never received, while the confirmation read "…and I can refer to it by
 * name". Beside a paperclip on an AI composer that reads as "I've got it", so the
 * professor did everything right, was told it worked, and concluded the AI was
 * broken. The first fix made the copy honest ("I can't read what's inside it") and
 * kept the capability gated to the About kind.
 *
 * The capability is now real on every kind and both surfaces, so the SAME invariant
 * inverts. What this file protects is the invariant, not either wording:
 *   1. the confirmation must not tell the professor Athena cannot read the file,
 *   2. the route must inline file parts on the path every kind reaches, with no
 *      per-kind gate in front of it,
 *   3. a file part must still only reach the model through the scope guard.
 *
 * This is a copy-and-contract test, deliberately: the defect IS the wording, and
 * wording silently regresses.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const PANEL = join(
  process.cwd(),
  'src/components/professor/assignments/athena/AssignmentAthenaPanel.tsx',
)
const ROUTE = join(process.cwd(), 'src/app/api/assignment-assistant/route.ts')

describe('#652 — the attach confirmation must not understate what Athena has', () => {
  const panel = readFileSync(PANEL, 'utf8')

  it('no longer tells the professor the contents are unreadable', () => {
    // The disclaimer that was correct while the bytes never reached the model.
    // It is now false on every surface, which is the same class of defect as the
    // original overpromise, pointing the other way.
    expect(panel).not.toContain("I can't read what's inside it")
  })

  it('no longer claims it can only refer to the file by name', () => {
    // The original phrase that created the wrong mental model.
    expect(panel).not.toContain('I can refer to it by name')
  })

  it('no longer routes the paperclip to the student-facing assignment upload', () => {
    // Student-facing files live in the builder's own "Add files & rubrics" step.
    // If this import comes back, the two meanings of the paperclip have merged again.
    expect(panel).not.toContain('uploadAssignmentAttachment')
  })

  it('stages every attachment through the shared chat-attachment hook', () => {
    expect(panel).toContain('useAthenaAttachments')
    expect(panel).toMatch(/chatAttachments\.addFiles\(\[file\]\)/)
  })

  it('says nothing about the file when staging rejected it', () => {
    // The hook toasts its own rejection and stages nothing. Falling through to a
    // host's onAttach from there would post "I've got it and can read it" about a
    // file Athena does not have — #652 again, on the path the #652 fix created.
    // Behaviour of the returned value is covered in athena-attachment-staging.
    expect(panel).toMatch(/const staged = chatAttachments\.addFiles\(\[file\]\)/)
    expect(panel).toMatch(/if \(staged\.length === 0\) return/)
  })

  it('never pastes a host pipeline\'s raw error into the transcript', () => {
    // Those strings are pipeline vocabulary ("Unsupported file type for
    // extraction") and land beside a sentence saying the file IS readable, so
    // they read as a contradiction in the professor's own chat.
    expect(panel).not.toMatch(/postAthenaNote\([^)]*\$\{res\.error\}/)
  })
})

describe('#652 — the assistant route inlines files on every kind', () => {
  const route = readFileSync(ROUTE, 'utf8')
  // Strip comments: the prose still discusses the old About-only gate, and a
  // substring check would otherwise match the explanation rather than the code.
  const code = route
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    .join('\n')

  it('has no per-kind gate in front of the materialize call', () => {
    const calls = code.match(/materializeFileParts\s*\(/g) ?? []
    expect(calls).toHaveLength(1)
    // The gate that used to stand here. Its return would silently re-break every
    // surface but About, with no other test failing.
    expect(code).not.toContain("activeKind === 'about' && attachmentPrefix")
    expect(code).toMatch(/if \(attachmentPrefix\) \{/)
  })

  it('builds the scope prefix unconditionally, from server-verified values', () => {
    // institutionId comes from loadAssistantContext and sectionId from the verified
    // access check. A client-supplied value entering this prefix is the breach.
    expect(code).toMatch(/const attachmentPrefix = athenaAttachmentPrefix\(\{/)
    expect(code).toMatch(/institutionId: context\.institutionId/)
    expect(code).toMatch(/scopeId: conversationId/)
  })

  it('still caps how many attachments are re-inlined per turn', () => {
    // Attachments re-inline on every later turn of a thread. Dropping the cap makes
    // a few large files a permanent tax on every message that follows them.
    expect(code).toMatch(/modelDef\.attachments\.maxFiles/)
  })

  it('keeps the fail-closed fallback that strips un-materialized file parts', () => {
    // An un-materialized file part would hand the provider a client-supplied URL.
    expect(code).toMatch(/parts\.filter\(\(p\) => !asFilePart\(p\)\)/)
  })
})
