/**
 * Centralized logging utility for Scholera.
 *
 * All application logging flows through this module so that log format,
 * filtering, and future integrations (e.g. Sentry, Datadog) can be
 * controlled from a single place.
 *
 * Log levels:
 * - error: Failed operations (always logged in production)
 * - warn:  Unexpected but recoverable situations (always logged)
 * - info:  Significant events like login / role-switch (always logged)
 * - debug: Diagnostic details for development (suppressed in production)
 *
 * All logs are prefixed with [SCHOLERA <LEVEL>] for easy filtering in
 * terminal output, browser console, or log aggregation tools.
 *
 * Convention for source strings:
 *   "ComponentName.methodName: Description" or "ComponentName: Description"
 *   e.g. "LoginPage.handleLogin: Success", "Middleware: Unauthenticated access"
 *
 * Usage:
 *   import { logger } from '@/lib/logger'
 *   logger.error('profileQueries.getProfileById', error, { userId })
 *   logger.warn('Missing profile', { userId })
 *   logger.info('Role switched', { userId, newRole })
 *   logger.debug('DashboardLayout: Rendering', { userId })
 */

/** Key-value pairs providing extra context for log messages */
type LogContext = Record<string, unknown>

/**
 * Converts a context object to a JSON string for log output.
 * Returns an empty string if context is undefined or empty,
 * keeping log lines clean when no extra data is needed.
 */
function formatContext(context?: LogContext): string {
  if (!context || Object.keys(context).length === 0) return ''
  return ' ' + JSON.stringify(context)
}

export const logger = {
  /**
   * Log a failed operation. Handles three error shapes:
   * 1. Standard Error objects — extracts message + stack trace
   * 2. Supabase error objects — extracts code, message, details, hint
   * 3. Unknown values — JSON-stringifies as a fallback
   *
   * Stack traces are logged on a separate line with [SCHOLERA STACK] prefix
   * so they can be easily grep'd or filtered.
   */
  error(source: string, error: unknown, context?: LogContext) {
    let message: string
    let stack: string | undefined

    if (error instanceof Error) {
      message = error.message
      stack = error.stack
    } else if (error && typeof error === 'object' && 'message' in error) {
      // Supabase errors: { message, code, details, hint }
      const supaErr = error as { message: string; code?: string; details?: string; hint?: string }
      message = `[${supaErr.code || 'UNKNOWN'}] ${supaErr.message}${supaErr.details ? ` | ${supaErr.details}` : ''}${supaErr.hint ? ` | hint: ${supaErr.hint}` : ''}`
    } else {
      message = JSON.stringify(error)
    }

    console.error(
      `[SCHOLERA ERROR] ${source}: ${message}${formatContext(context)}`
    )
    if (stack) {
      console.error(`[SCHOLERA STACK] ${stack}`)
    }
  },

  /** Log an unexpected but recoverable situation. Always active in production. */
  warn(source: string, context?: LogContext) {
    console.warn(`[SCHOLERA WARN] ${source}${formatContext(context)}`)
  },

  /** Log a significant application event. Always active in production. */
  info(source: string, context?: LogContext) {
    console.log(`[SCHOLERA INFO] ${source}${formatContext(context)}`)
  },

  /**
   * Log diagnostic information for development only.
   * Suppressed in production via NODE_ENV check to avoid noisy logs.
   */
  debug(source: string, context?: LogContext) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[SCHOLERA DEBUG] ${source}${formatContext(context)}`)
    }
  },
}
