import { describe, it, expect } from 'vitest'
import {
  buildSafeTree,
  isUnsafeEntryPath,
  classifyByName,
  extensionOf,
  imageMime,
  ZIP_LIMITS,
  type RawZipEntry,
} from '@/lib/assignments/zip'

function entry(fileName: string, opts: Partial<RawZipEntry> = {}): RawZipEntry {
  return {
    fileName,
    uncompressedSize: opts.uncompressedSize ?? 100,
    isDirectory: opts.isDirectory ?? fileName.endsWith('/'),
    isSymlink: opts.isSymlink ?? false,
  }
}

describe('buildSafeTree — normal listing', () => {
  it('keeps files, drops directory and symlink entries', () => {
    const res = buildSafeTree([
      entry('src/'),
      entry('src/main.py'),
      entry('README.md'),
      entry('link', { isSymlink: true }),
    ])
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.files.map((f) => f.path)).toEqual(['src/main.py', 'README.md'])
    }
  })

  it('returns an error when nothing previewable remains', () => {
    const res = buildSafeTree([entry('only/'), entry('../escape')])
    expect(res).toEqual({ ok: false, error: expect.any(String) })
  })
})

describe('buildSafeTree — zip-bomb guards', () => {
  it('rejects an archive with more raw entries than the hard cap', () => {
    const many = Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, i) => entry(`f${i}.txt`))
    expect(buildSafeTree(many).ok).toBe(false)
  })

  it('truncates (does not reject) an archive with more files than the display cap', () => {
    const many = Array.from({ length: ZIP_LIMITS.maxFiles + 25 }, (_, i) => entry(`f${i}.txt`))
    const res = buildSafeTree(many)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.files).toHaveLength(ZIP_LIMITS.maxFiles)
      expect(res.omitted).toBe(25)
    }
  })

  it('rejects when declared uncompressed total exceeds the cap', () => {
    const big = 150 * 1024 * 1024 // 150 MB each → 300 MB > 200 MB cap
    const res = buildSafeTree([
      entry('a.bin', { uncompressedSize: big }),
      entry('b.bin', { uncompressedSize: big }),
    ])
    expect(res.ok).toBe(false)
  })
})

describe('buildSafeTree — path safety', () => {
  it('drops traversal, absolute, drive-letter, and backslash paths', () => {
    const res = buildSafeTree([
      entry('../../etc/passwd'),
      entry('/abs/secret'),
      entry('C:\\windows\\system32'),
      entry('a\\b.txt'),
      entry('good/keep.py'),
    ])
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.files.map((f) => f.path)).toEqual(['good/keep.py'])
  })

  it('drops paths nested deeper than the depth cap', () => {
    const deep = Array.from({ length: ZIP_LIMITS.maxDepth + 2 }, () => 'd').join('/') + '/x.py'
    const res = buildSafeTree([entry(deep), entry('shallow.py')])
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.files.map((f) => f.path)).toEqual(['shallow.py'])
  })

  it('hides macOS junk (__MACOSX, ._ sidecars, .DS_Store)', () => {
    const res = buildSafeTree([
      entry('__MACOSX/foo/._bar.py'),
      entry('proj/._main.py'),
      entry('proj/.DS_Store'),
      entry('proj/main.py'),
    ])
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.files.map((f) => f.path)).toEqual(['proj/main.py'])
  })
})

describe('isUnsafeEntryPath', () => {
  it.each([
    ['../x', true],
    ['/abs', true],
    ['C:/x', true],
    ['a\\b', true],
    ['a\0b', true],
    ['', true],
    ['src/main.py', false],
    ['a/b/c.txt', false],
  ])('%s → %s', (path, unsafe) => {
    expect(isUnsafeEntryPath(path)).toBe(unsafe)
  })
})

describe('classifyByName', () => {
  it.each([
    ['main.py', 'text'],
    ['notes.MD', 'text'],
    ['diagram.png', 'image'],
    ['photo.JPG', 'image'],
    ['report.pdf', 'pdf'],
    ['hw.ipynb', 'notebook'], // notebooks render via the notebook viewer, not raw text
    ['nested.zip', 'binary'], // nested archive shows as a non-previewable leaf (no recursion)
    ['app.exe', 'binary'],
  ])('%s → %s', (name, kind) => {
    expect(classifyByName(name)).toBe(kind)
  })
})

describe('extensionOf / imageMime', () => {
  it('reads extensions and dotless basenames', () => {
    expect(extensionOf('a/b/c.TS')).toBe('ts')
    expect(extensionOf('path/Dockerfile')).toBe('dockerfile')
  })
  it('maps image extensions to MIME types', () => {
    expect(imageMime('x.png')).toBe('image/png')
    expect(imageMime('x.jpeg')).toBe('image/jpeg')
    expect(imageMime('x.gif')).toBe('image/gif')
    expect(imageMime('x.webp')).toBe('image/webp')
  })
})
