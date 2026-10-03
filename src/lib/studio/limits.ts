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
/** Stage 2 runs (studio_runtime_admit enforces these under a lock). Professor lane, per
 * institution: at once, and per rolling day counting only runs that reached a verdict.
 * System lane (revalidation), per institution, at once. Everywhere, at once. */
export const STUDIO_VALIDATOR_STAGE2_INSTITUTION_CONCURRENT = 2
export const STUDIO_VALIDATOR_STAGE2_INSTITUTION_DAILY = 30
export const STUDIO_VALIDATOR_STAGE2_SYSTEM_CONCURRENT = 1
export const STUDIO_VALIDATOR_STAGE2_GLOBAL_CONCURRENT = 10
/** Purpose-classifier calls per institution per rolling day; over it the purpose check goes to review. */
export const STUDIO_PURPOSE_DAILY_PER_INSTITUTION = 100
/** Installations one revalidation job re-checks before handing off to the next. */
export const STUDIO_REVALIDATE_PAGE = 25
/** Checks the super admin's review queue lists at once. */
export const STUDIO_REVIEW_QUEUE_LISTED = 100

/** Bytes of metadata stored per check; the database refuses more than 4096. */
export const STUDIO_VALIDATOR_CHECK_METADATA_MAX_BYTES = 3500
/** Text sent to the purpose classifier: the manifest's own words, never code. */
export const STUDIO_PURPOSE_TEXT_MAX_BYTES = 8 * 1024
/** The classifier's lowest confidence that can pass the purpose check. */
export const STUDIO_PURPOSE_CONFIDENCE_MIN = 0.85

// ── The builder agent (docs/reference/studio-agent-harness.md) ──
// Policy defaults approved for Step 7B. The database functions take the caps they enforce
// as arguments from here; its CHECK constraints are backstops at or above these.

/** Per run. A typical first build is about 15 turns; the rest covers repair rounds. */
export const STUDIO_BUILDER_MAX_MODEL_TURNS = 24
export const STUDIO_BUILDER_MAX_TOOL_CALLS = 48
/** Calls one model turn may propose. The rest are refused as one error. */
export const STUDIO_BUILDER_MAX_TOOL_CALLS_PER_TURN = 8
/** Applied file writes and edits, plus manifest proposals that apply or pause. */
export const STUDIO_BUILDER_MAX_WRITES = 30
export const STUDIO_BUILDER_MAX_BYTES_WRITTEN = 256 * 1024
/** Model time inside slices only; queue and approval waits don't count. */
export const STUDIO_BUILDER_RUN_MAX_ACTIVE_MS = 20 * 60_000
/** Checked before every model call against the run's spend plus a worst-case next call. */
export const STUDIO_BUILDER_RUN_MAX_COST_USD = 2.5
/** Questions one run may ask the professor. */
export const STUDIO_BUILDER_MAX_QUESTIONS = 2

/** Per professor, rolling 24 hours. */
export const STUDIO_BUILDER_DAILY_RUNS_PER_PROFESSOR = 15
/** Per institution: runs queued or running at once, and rolling 24-hour spend. */
export const STUDIO_BUILDER_MAX_LIVE_RUNS_PER_INSTITUTION = 3
export const STUDIO_BUILDER_INSTITUTION_DAILY_COST_USD = 100

/** Repair (approved decision 1.9). */
export const STUDIO_BUILDER_MAX_REPAIR_ROUNDS = 3
export const STUDIO_BUILDER_MAX_CHECK_RUNS = 6
/** A blocking finding (check and file) still present after this many repair rounds ends the run. */
export const STUDIO_BUILDER_SAME_FINDING_LIMIT = 2
export const STUDIO_BUILDER_MAX_CONSECUTIVE_ERRORS = 3

/** The draft. A full rewrite of a 32 KiB view fits the output cap. */
export const STUDIO_BUILDER_FILE_MAX_BYTES = 32 * 1024
export const STUDIO_BUILDER_EDIT_OLD_TEXT_MAX_BYTES = 8 * 1024
export const STUDIO_BUILDER_MANIFEST_MAX_BYTES = 32 * 1024
export const STUDIO_BUILDER_PLAN_MAX_BYTES = 8 * 1024

/** The check worker: one compile and typecheck of both views. */
export const STUDIO_BUILDER_CHECK_TIMEOUT_MS = 10_000
export const STUDIO_BUILDER_CHECK_WORKER_MAX_MB = 512
/** Findings the model sees from one check, and per check id. */
export const STUDIO_BUILDER_FINDINGS_MAX = 40
export const STUDIO_BUILDER_DIAGNOSTICS_MAX = 20
/** Characters of one compiler or typecheck message. */
export const STUDIO_BUILDER_MESSAGE_MAX_CHARS = 200

/** Context and prose. */
export const STUDIO_BUILDER_CONTEXT_MAX_TOKENS = 64_000
export const STUDIO_BUILDER_MAX_OUTPUT_TOKENS = 24_000
export const STUDIO_BUILDER_TOOL_RESULT_MAX_BYTES = 8 * 1024
export const STUDIO_BUILDER_REQUEST_MAX_CHARS = 4000
export const STUDIO_BUILDER_ANSWER_MAX_CHARS = 4000
export const STUDIO_BUILDER_SUMMARY_MAX_CHARS = 1000
export const STUDIO_BUILDER_QUESTION_MAX_CHARS = 1000
export const STUDIO_BUILDER_OPEN_QUESTIONS_MAX = 5
/** Earlier builds of the project shown to the model, and how much of each request. */
export const STUDIO_BUILDER_HISTORY_RUNS = 3
export const STUDIO_BUILDER_HISTORY_REQUEST_MAX_CHARS = 600
export const STUDIO_BUILDER_SKILLS_IN_CONTEXT = 100
/** The professor's draft history list, and how much of each request it shows. */
export const STUDIO_BUILDER_DRAFT_HISTORY_MAX = 20
export const STUDIO_BUILDER_DRAFT_HISTORY_REQUEST_MAX_CHARS = 120

/** Time. A slice ends before the job worker's lease and inside the 600 s the Cloud
 * Scheduler sweep holds its request open (docs/reference/studio-agent-harness.md, "Where
 * a build runs"). */
export const STUDIO_BUILDER_SLICE_MAX_MS = 480_000
/** Time a slice keeps in hand for one more turn: a model call, a check and its writes. */
export const STUDIO_BUILDER_SLICE_CUSHION_MS = 270_000
/** A drain with less time left than this doesn't start a builder slice. */
export const STUDIO_BUILDER_SLICE_MIN_BUDGET_MS = 300_000
export const STUDIO_BUILDER_MAX_SLICES = 32
export const STUDIO_BUILDER_MODEL_CALL_TIMEOUT_MS = 240_000
/** How quickly Stop reaches a model call in flight. */
export const STUDIO_BUILDER_HEARTBEAT_MS = 5_000
/** A slice silent this long is presumed dead and its run may be re-claimed. */
export const STUDIO_BUILDER_HEARTBEAT_STALE_MS = 60_000
export const STUDIO_BUILDER_MAX_RESUMES = 2
/** Runs the job worker's sweep tends per kick, oldest first; the rest wait for the next kick. */
export const STUDIO_BUILDER_SWEEP_LIMIT = 50
/** How long an approval card or a question waits for the professor. */
export const STUDIO_BUILDER_WAITING_TTL_MS = 72 * 3600_000

// ── Project memory (docs/reference/studio-agent-harness.md, "Project memory") ──
// The database enforces the active cap and the field lengths as backstops.

/** Active decisions one project keeps. */
export const STUDIO_MEMORY_MAX_ACTIVE = 20
/** Proposals one run may raise. */
export const STUDIO_MEMORY_PROPOSALS_PER_RUN = 2
export const STUDIO_MEMORY_STATEMENT_MAX_CHARS = 200
/** The professor's quoted words that support a proposal. */
export const STUDIO_MEMORY_EVIDENCE_MIN_CHARS = 4
export const STUDIO_MEMORY_EVIDENCE_MAX_CHARS = 200
/** What one turn's prompt carries: up to 6 constraints and 4 preferences, 8 in all and 2 KiB. */
export const STUDIO_MEMORY_CONSTRAINTS_MAX = 6
export const STUDIO_MEMORY_PREFERENCES_MAX = 4
export const STUDIO_MEMORY_CONTEXT_MAX_ITEMS = 8
export const STUDIO_MEMORY_CONTEXT_MAX_BYTES = 2048
/** An unanswered proposal is rejected after this long, by the builder's upkeep. */
export const STUDIO_MEMORY_PROPOSAL_TTL_MS = STUDIO_BUILDER_WAITING_TTL_MS
export const STUDIO_MEMORY_EXPIRE_LIMIT = 100

// ── Course material (Step 9, docs/reference/studio-agent-harness.md, "Course material") ──
// Every cap is in UTF-8 bytes, measured after labels. One search's result to the model is
// held to STUDIO_BUILDER_TOOL_RESULT_MAX_BYTES.

/** search_course_material calls one run may make. */
export const STUDIO_BUILDER_MAX_SEARCHES = 3
/** Excerpts one search returns, at most. */
export const STUDIO_COURSE_RESULTS_MAX = 6
export const STUDIO_COURSE_EXCERPT_MAX_BYTES = 1200
/** The course-material block one prompt carries. The oldest whole search goes first. */
export const STUDIO_COURSE_BLOCK_MAX_BYTES = 12 * 1024
export const STUDIO_COURSE_QUERY_MAX_BYTES = 200
export const STUDIO_COURSE_LABEL_MAX_CHARS = 80
/** How long the harness waits for a search or a re-read before carrying on without it. */
export const STUDIO_COURSE_TIMEOUT_MS = 3_000
/** Unopened source keys a run or a project keeps (studio_material_prune keeps the newest 96 too). */
export const STUDIO_MATERIAL_SOURCES_MAX = 96

/** Progress polling, and the most trajectory rows one poll returns. */
export const STUDIO_BUILDER_PROGRESS_POLL_MS = 1_500
export const STUDIO_BUILDER_PROGRESS_EVENTS_MAX = 50
