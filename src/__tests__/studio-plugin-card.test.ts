/**
 * The plugin card a professor reads before showing a plugin to students (rule 8.2).
 * Every line must come from the manifest or the storage figures, and nothing the card
 * says may be wider than what the server actually allows.
 */
import { describe, expect, it } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { parseManifest, type StudioManifest } from '@/lib/studio/manifest'
import { buildPluginCard, formatBytes } from '@/lib/studio/plugin-card'

const parsed = parseManifest(exitTicket)
if (!parsed.ok) throw new Error('fixture manifest is invalid')
const manifest: StudioManifest = parsed.manifest
const STORAGE = {
  records: 1234,
  bytes: 1536,
  installationMaxRecords: 50_000,
  installationMaxBytes: 50 * 1024 * 1024,
  studentMaxRecords: 1000,
  studentMaxBytes: 1024 * 1024,
}

describe('buildPluginCard', () => {
  const card = buildPluginCard(manifest, STORAGE)

  it('names the plugin and version from the manifest', () => {
    expect(card).toMatchObject({ name: exitTicket.name, version: exitTicket.version, description: exitTicket.description })
  })

  it('students: what they can do with their view, saving their own perStudent work, reading shared', () => {
    expect(card.students).toEqual([
      'See this course’s name and whether the person using it is a student or staff',
      'Read questions',
      'Save their own responses',
    ])
  })

  it('leaves out how the tool sits on the page: resizing and notifications aren’t abilities', () => {
    expect([...card.students, ...card.professors].some((l) => /Fit itself|notifications/.test(l))).toBe(false)
  })

  it('turns code names into words', () => {
    const named = buildPluginCard(
      { ...manifest, collections: { exitTickets: { access: 'perStudent', fields: { muddiestPoint: 'text' } } } },
      STORAGE,
    )
    expect(named.students).toContain('Save their own exit tickets')
    expect(named.data).toEqual([{ name: 'exit tickets', fields: ['muddiest point'], access: expect.any(String) }])
  })

  it('never tells the professor a student can reach staff-only data', () => {
    const withKeys = buildPluginCard(
      { ...manifest, collections: { ...manifest.collections, answerKeys: { access: 'staffOnly', fields: { correct: 'text' } } } },
      STORAGE,
    )
    expect(withKeys.students.some((line) => line.includes('answer keys'))).toBe(false)
    expect(withKeys.professors).toContain('Read and write answer keys')
    expect(withKeys.data.find((d) => d.name === 'answer keys')?.access).toMatch(/Never sent to a student/)
  })

  it('professors: their view’s capabilities and every collection', () => {
    expect(card.professors).toContain('See which skills the class is struggling with')
    expect(card.professors).toContain('Read every student’s responses')
    expect(card.professors).toContain('Read and write questions')
  })

  it('lists the data it saves, with fields and who sees it', () => {
    expect(card.data).toEqual([
      { name: 'questions', fields: ['prompt', 'skill', 'open'], access: 'Written by staff, read by everyone in the course' },
      { name: 'responses', fields: ['question id', 'answer', 'confidence'], access: expect.stringMatching(/A student sees only theirs/) },
    ])
  })

  it('says plainly there is no AI, grading or tracking, rather than leaving it out', () => {
    expect(card.ai).toMatch(/^None/)
    expect(card.grading).toMatch(/^None/)
    expect(card.tracking).toMatch(/^None/)
  })

  it('shows storage use and each student’s allowance', () => {
    expect(card.storage).toEqual({
      used: '1,234 of 50,000 saved entries, 1.5 KB of 50 MB',
      perStudent: 'Each student can save up to 1,000 entries (1 MB)',
    })
    expect(buildPluginCard(manifest, null).storage).toBeNull()
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 bytes'],
    [512, '512 bytes'],
    [1536, '1.5 KB'],
    [20 * 1024, '20 KB'],
    [52_428_800, '50 MB'],
  ])('%s is %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })
})
