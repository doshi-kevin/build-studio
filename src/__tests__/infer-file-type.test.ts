// @vitest-environment node
//
// fileType is inferred from the upload's filename, not a dropdown — these assert
// the extension→canonical-fileType mapping the extraction dispatcher routes on.
import { describe, it, expect } from 'vitest'
import { inferLectureFileType } from '@/lib/supabase/storage'

describe('inferLectureFileType', () => {
  it.each([
    ['lecture-3.pdf', 'pdf'],
    ['Deck.PPTX', 'ppt'],
    ['slides.ppt', 'ppt'],
    ['notes.docx', 'docx'],
    ['old.doc', 'docx'],
    ['grades.xlsx', 'xlsx'],
    ['data.xls', 'xlsx'],
    ['diagram.PNG', 'image'],
    ['photo.jpeg', 'image'],
    ['vector.svg', 'image'],
  ])('maps %s → %s', (name, expected) => {
    expect(inferLectureFileType(name)).toBe(expected)
  })

  it('routes plain text to the text extractor', () => {
    // Was 'notes', which no extractor handled — a .txt upload was stored and
    // then ignored entirely: no pages, no topics, no rail, no retrieval.
    expect(inferLectureFileType('readme.txt')).toBe('text')
    expect(inferLectureFileType('lecture-notes.md')).toBe('text')
  })

  it('still falls back to notes for anything unreadable', () => {
    expect(inferLectureFileType('archive.zip')).toBe('notes')
    expect(inferLectureFileType('noextension')).toBe('notes')
  })
})
