/**
 * Byte-level ZIP reading for in-app submission preview. Server-only (imports `yauzl`,
 * a Node library). All policy lives in `zip.ts`; this file just reads.
 *
 * Why `yauzl`: it reads the central directory (entry names + declared sizes) WITHOUT
 * decompressing, so we can reject a zip bomb before extracting anything, and then
 * extract only the single entry the user clicked. We always work from an in-memory
 * buffer (`fromBuffer`) — nothing is ever written to disk or executed.
 */

import yauzl from 'yauzl'
import { ZIP_LIMITS, type RawZipEntry } from './zip'

const S_IFMT = 0o170000
const S_IFLNK = 0o120000

/** Detect a symlink entry from its stored unix mode (high 16 bits of the attrs). */
function isSymlinkEntry(externalFileAttributes: number): boolean {
  const unixMode = (externalFileAttributes >>> 16) & 0xffff
  return (unixMode & S_IFMT) === S_IFLNK
}

/**
 * Read every entry's metadata from the central directory. Does not decompress any
 * file contents. Rejects if the buffer isn't a readable zip.
 */
export function readCentralDirectory(buffer: Buffer): Promise<RawZipEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Invalid zip'))
      const entries: RawZipEntry[] = []
      zip.on('entry', (entry) => {
        entries.push({
          fileName: entry.fileName,
          uncompressedSize: entry.uncompressedSize,
          isDirectory: entry.fileName.endsWith('/'),
          isSymlink: isSymlinkEntry(entry.externalFileAttributes),
        })
        // Stop accumulating once we're one past the cap — buildSafeTree rejects on
        // `> maxEntries`, so we never hold a hostile millions-of-entries directory in memory.
        if (entries.length > ZIP_LIMITS.maxEntries) {
          resolve(entries)
          return
        }
        zip.readEntry()
      })
      zip.on('end', () => resolve(entries))
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}

export interface EntryBytes {
  buffer: Buffer
  truncated: boolean
}

/**
 * Extract a single entry by exact path, streaming and stopping at `maxBytes`. The cap
 * defends against a lying central directory (declared size small, real size huge): we
 * never hold more than `maxBytes` of one entry in memory. Returns `null` if the entry
 * isn't present or can't be opened.
 */
export function readEntryBytes(
  buffer: Buffer,
  entryPath: string,
  maxBytes: number,
): Promise<EntryBytes | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: EntryBytes | null) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Invalid zip'))

      let found = false
      zip.on('entry', (entry) => {
        if (entry.fileName !== entryPath) {
          zip.readEntry()
          return
        }
        found = true
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return finish(null)

          const chunks: Buffer[] = []
          let size = 0
          let truncated = false

          stream.on('data', (chunk: Buffer) => {
            if (truncated) return
            const remaining = maxBytes - size
            if (chunk.length >= remaining) {
              if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
              size = maxBytes
              truncated = true
              stream.destroy()
              return
            }
            chunks.push(chunk)
            size += chunk.length
          })
          stream.on('end', () => finish({ buffer: Buffer.concat(chunks), truncated }))
          stream.on('close', () => finish({ buffer: Buffer.concat(chunks), truncated }))
          stream.on('error', () => finish({ buffer: Buffer.concat(chunks), truncated }))
        })
      })
      zip.on('end', () => {
        if (!found) finish(null)
      })
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}
