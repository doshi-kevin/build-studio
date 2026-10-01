/** Plugin rule 10.1: every limit is a named platform setting. Each value is set by the
 * Studio slice that first needs it (rule 10.2). */

// The manifest.
export const STUDIO_MANIFEST_MAX_COLLECTIONS = 10
export const STUDIO_MANIFEST_MAX_FIELDS = 30

// Plugin records. Server actions accept bodies up to 260 MB (next.config.ts), so the
// record service enforces its own cap rather than relying on the transport.
export const STUDIO_RECORD_MAX_BYTES = 16 * 1024
export const STUDIO_RECORD_PAGE_MAX = 100
