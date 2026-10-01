/**
 * Pure, I/O-free guards + classification for viewing submitted ZIP archives in-app.
 *
 * No `yauzl` import here — the byte-level reading lives in `zip-reader.ts`. Keeping the
 * decision logic pure (no Node/storage deps) makes the zip-bomb / path-traversal rules
 * unit-testable, which is the part a reviewer scrutinises hardest. Nothing here ever
 * executes archive contents; we only decide what is safe to *show*.
 */

/** Limits that keep a hostile archive from harming the server or the page. */
export const ZIP_LIMITS = {
  /** Hard cap on raw central-directory entries we'll even process (work bound). */
  maxEntries: 20000,
  /** Soft cap on files we display; beyond this we truncate the tree and say so. */
  maxFiles: 2000,
  /** Reject if the declared uncompressed total exceeds this (zip-bomb guard). */
  maxTotalUncompressedBytes: 200 * 1024 * 1024,
  /** Never extract a single entry larger than this. */
  maxEntryBytes: 25 * 1024 * 1024,
  /** Skip entries nested deeper than this many folders. */
  maxDepth: 32,
  /** Truncate a previewed text file at this size. */
  maxTextPreviewBytes: 1024 * 1024,
  /** Largest entry we return inline (base64) for image/PDF preview. */
  maxInlinePreviewBytes: 10 * 1024 * 1024,
} as const

/** Raw entry metadata read from the zip's central directory (see `zip-reader.ts`). */
export interface RawZipEntry {
  fileName: string
  uncompressedSize: number
  isDirectory: boolean
  isSymlink: boolean
}

/** A file we're willing to surface in the tree. Directories are implied by paths. */
export interface ZipFileNode {
  /** POSIX path inside the archive, e.g. `src/main.py`. */
  path: string
  /** Declared uncompressed size in bytes. */
  size: number
}

export type SafeTreeResult =
  | { ok: true; files: ZipFileNode[]; omitted: number }
  | { ok: false; error: string }

export type PreviewKind = 'text' | 'image' | 'pdf' | 'notebook' | 'binary'

/**
 * True for macOS archive cruft we hide from the tree: the `__MACOSX/` resource-fork
 * folder, AppleDouble `._*` sidecars, and `.DS_Store`. Hiding these is cosmetic, not a
 * security measure.
 */
export function isJunkPath(name: string): boolean {
  if (name.startsWith('__MACOSX/')) return true
  const base = name.split('/').pop() ?? name
  return base === '.DS_Store' || base.startsWith('._')
}

/**
 * True for a path we refuse to surface: traversal (`..`), absolute, drive-letter,
 * backslash, or null byte. We never write entries to disk, but we also never show a
 * path that tries to escape the archive root.
 */
export function isUnsafeEntryPath(name: string): boolean {
  if (!name) return true
  if (name.includes('\0')) return true
  if (name.includes('\\')) return true // backslash → Windows path / escape attempt
  if (name.startsWith('/')) return true // absolute
  if (/^[a-zA-Z]:/.test(name)) return true // drive letter (C:\…)
  return name.split('/').some((segment) => segment === '..')
}

/** Number of folders a file path sits under (`a/b/c.txt` → 2). */
function depthOf(path: string): number {
  return path.split('/').filter(Boolean).length - 1
}

/**
 * Apply every guard to the archive's declared entries and return the files we'll show.
 * Directories, symlinks, junk, and unsafe/over-deep paths are dropped silently. A
 * genuine zip-bomb (huge declared total) still fails hard; an archive with simply *many*
 * files degrades gracefully — we show the first `maxFiles` and report how many were
 * omitted, rather than refusing the whole thing.
 */
export function buildSafeTree(entries: RawZipEntry[]): SafeTreeResult {
  if (entries.length > ZIP_LIMITS.maxEntries) {
    return { ok: false, error: 'This archive has too many files to preview.' }
  }

  const files: ZipFileNode[] = []
  let total = 0

  for (const entry of entries) {
    if (entry.isSymlink) continue // never follow links
    if (entry.isDirectory) continue // dirs are implied by file paths
    if (isUnsafeEntryPath(entry.fileName)) continue // drop traversal/absolute
    if (isJunkPath(entry.fileName)) continue // hide macOS cruft
    if (depthOf(entry.fileName) > ZIP_LIMITS.maxDepth) continue

    const size =
      Number.isFinite(entry.uncompressedSize) && entry.uncompressedSize > 0
        ? entry.uncompressedSize
        : 0
    total += size
    if (total > ZIP_LIMITS.maxTotalUncompressedBytes) {
      return { ok: false, error: 'This archive is too large to preview safely.' }
    }

    files.push({ path: entry.fileName, size })
  }

  if (files.length === 0) {
    return { ok: false, error: 'No previewable files were found in this archive.' }
  }

  const omitted = Math.max(0, files.length - ZIP_LIMITS.maxFiles)
  return { ok: true, files: omitted > 0 ? files.slice(0, ZIP_LIMITS.maxFiles) : files, omitted }
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log',
  'py', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'env', 'properties',
  'java', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'go', 'rb', 'rs', 'php', 'swift',
  'kt', 'kts', 'scala', 'r', 'jl', 'm', 'lua', 'pl', 'sql',
  'sh', 'bash', 'zsh', 'ps1', 'bat',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'csv', 'tsv',
  'gitignore', 'dockerfile', 'makefile',
])

/** Lowercased extension (or the whole basename for dotfiles like `Dockerfile`). */
export function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot === -1 ? base.toLowerCase() : base.slice(dot + 1).toLowerCase()
}

/**
 * Decide how (or whether) a file inside the archive can be previewed in-app.
 *
 * Note: `svg`, `html`, and `htm` are deliberately classified as `text` (shown as escaped
 * source via CodeFileViewer), NOT as renderable images/markup — both can carry script.
 * Do not move them to `image`/HTML rendering without sanitizing; that would be an XSS hole.
 */
export function classifyByName(name: string): PreviewKind {
  const ext = extensionOf(name)
  if (ext === 'ipynb') return 'notebook'
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'binary'
}

/** MIME type for an image entry (for inline preview). */
export function imageMime(name: string): string {
  switch (extensionOf(name)) {
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    default:
      return 'image/jpeg' // jpg / jpeg
  }
}
