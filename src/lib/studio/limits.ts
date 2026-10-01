/** Plugin rule 10.1: every limit is a named platform setting. Each value is set by the
 * Studio slice that first needs it (rule 10.2). */

// The manifest.
export const STUDIO_MANIFEST_MAX_COLLECTIONS = 10
export const STUDIO_MANIFEST_MAX_FIELDS = 30

// Plugin records. Server actions accept bodies up to 260 MB (next.config.ts), so the
// record service enforces its own cap rather than relying on the transport.
export const STUDIO_RECORD_MAX_BYTES = 16 * 1024
export const STUDIO_RECORD_PAGE_MAX = 100

// The runtime frame and the Scholera Bridge (docs/reference/studio-plugin-runtime.md).
export const STUDIO_BRIDGE_MAX_MESSAGE_BYTES = 64 * 1024
/** Per user per installation, all methods. Enforced in memory per server instance:
 * not globally authoritative. Anything that costs money (AI) needs a durable counter. */
export const STUDIO_BRIDGE_CALLS_PER_MINUTE = 120
/** Per user per installation, write methods only (also counted in the limit above). */
export const STUDIO_BRIDGE_WRITES_PER_MINUTE = 30
/** Per user across every installation, checked before the installation is looked up, so
 * calls naming made-up installations spend it too. 2.5 installations' worth: a professor
 * can run two or three plugins flat out at once, and rotating installation IDs gains at
 * most 300 lookups a minute. Same in-memory caveat as above. */
export const STUDIO_BRIDGE_USER_CALLS_PER_MINUTE = 300

// Host-only methods (never reach the server).
/** ui.resize: the host clamps every requested height to this range. */
export const STUDIO_FRAME_MIN_HEIGHT_PX = 160
export const STUDIO_FRAME_MAX_HEIGHT_PX = 2400
/** ui.toast: characters per message, and messages per frame per minute. */
export const STUDIO_TOAST_MAX_CHARS = 160
export const STUDIO_TOASTS_PER_MINUTE = 6

/** course.skills: the most skills returned for one section. */
export const STUDIO_SKILLS_MAX = 500
/** Requests the host refuses locally for rate in one minute before it stops the frame. */
export const STUDIO_FRAME_RATE_ABUSE_MAX = 60
export const STUDIO_FRAME_START_TIMEOUT_MS = 10_000
export const STUDIO_FRAME_HELLO_TIMEOUT_MS = 5_000
export const STUDIO_FRAME_MALFORMED_MAX = 20
/** How long a signed frame ticket stays valid. Only long enough to load the frame. */
export const STUDIO_FRAME_TICKET_TTL_MS = 60_000
/** How often an open frame asks the server whether it may keep running (hidden, kill
 * switch, entitlement, version). A frame that makes no bridge calls still closes within
 * one interval. Each check is one read against the bridge's rate limits. */
export const STUDIO_FRAME_STATUS_INTERVAL_MS = 60_000

// Storage quotas (records and bytes, per installation and per student) are named
// settings in one database row, enforced by the usage trigger in the same transaction
// as each write. Read them with db.loadQuotaLimits. They have no copy here, so they
// can't drift.
/** The most installations a section's navigation lists. Not a cap on installing: there
 * is none in V1. A bound on the read, far above any real course. */
export const STUDIO_SECTION_INSTALLATIONS_LISTED = 100
/** The most versions the professor's preview picker lists, newest first. */
export const STUDIO_PROJECT_VERSIONS_LISTED = 50
/** Showing a plugin to students warns the professor above this share of an installation limit. */
export const STUDIO_QUOTA_WARNING_RATIO = 0.8

// ── The pre-publish validator (docs/reference/studio-plugin-validator.md) ──
// Sized against what Athena generates (a few files, tens of KiB) and what each stage
// costs. Every run records the ruleset these values belong to.

/** All source files of one version together. About ten times a large generated plugin. */
export const STUDIO_SOURCE_MAX_BYTES = 512 * 1024
/** Generated plugins have a handful of files; this stops "thousands of tiny files". */
export const STUDIO_SOURCE_MAX_FILES = 100
/** One generated file larger than this is a bug or an attack. */
export const STUDIO_SOURCE_FILE_MAX_BYTES = 128 * 1024
/** One view's bundle. Plugin code only: React and the kit come from the runtime
 * (vendor.js), so a real bundle is a few KiB. Every frame load sends it. */
export const STUDIO_BUNDLE_MAX_BYTES = 256 * 1024
/** Bracket nesting in a bundle, measured before parsing. Real code nests tens deep;
 * very deep nesting is the classic way to crash a recursive parser. */
export const STUDIO_VALIDATOR_MAX_NESTING = 500
/** Syntax nodes walked per bundle. Comfortably above 256 KiB of real code. */
export const STUDIO_VALIDATOR_MAX_NODES = 500_000
/** Wall time for all static checks of one version. A legal-size plugin takes well under
 * a second; past this the run ends as `error`, never `passed`. */
export const STUDIO_VALIDATOR_STATIC_TIMEOUT_MS = 10_000
/** Findings reported per check. Athena needs the first problems, not thousands. */
export const STUDIO_VALIDATOR_FINDINGS_PER_CHECK = 20
/** Text of one identifier or value quoted in a finding. */
export const STUDIO_VALIDATOR_QUOTE_MAX_CHARS = 80
/** The runtime stage: one view's scenarios, then the whole run, then the browser. */
export const STUDIO_VALIDATOR_VIEW_TIMEOUT_MS = 30_000
export const STUDIO_VALIDATOR_RUNTIME_TIMEOUT_MS = 180_000
/** Target memory for the runtime container (headless Chromium plus one plugin). */
export const STUDIO_VALIDATOR_RUNTIME_MEMORY_MB = 2048
/** Console lines and bytes kept from a runtime run; the rest is dropped. */
export const STUDIO_VALIDATOR_LOG_MAX_LINES = 200
export const STUDIO_VALIDATOR_LOG_MAX_BYTES = 32 * 1024
/** Screenshots or other files a runtime run may return. None are kept in V1. */
export const STUDIO_VALIDATOR_MAX_ARTIFACTS = 0
/** How long a runtime run's callback token is valid. */
export const STUDIO_VALIDATOR_CALLBACK_TTL_MS = 15 * 60_000
/** After a stage of a version ends in error, how long before the professor can run it
 * again. Each retry may spend browser time and an AI call. */
export const STUDIO_VALIDATOR_RETRY_COOLDOWN_MS = 60_000
/** Bytes of metadata stored per check; the database refuses more than 4096. */
export const STUDIO_VALIDATOR_CHECK_METADATA_MAX_BYTES = 3500
/** Text sent to the purpose classifier: the manifest's own words, never code. */
export const STUDIO_PURPOSE_TEXT_MAX_BYTES = 8 * 1024
/** The classifier's lowest confidence that can pass the purpose check. */
export const STUDIO_PURPOSE_CONFIDENCE_MIN = 0.85
