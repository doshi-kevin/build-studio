/**
 * Methods the host answers itself, never sent to the server (catalog.ts marks them
 * runs: 'host'). The plugin only asks; the host decides.
 *
 *   ui.resize  The host clamps the requested height to its own range and applies that.
 *   ui.toast   A short, plain-text Scholera toast in one of three tones. The host renders
 *              it as text and labels it with the plugin's name, so a plugin can't pass
 *              off its message as Scholera's.
 */
import { METHOD_CATALOG, parseMethodArgs } from '../bridge/catalog'
import { STUDIO_FRAME_MAX_HEIGHT_PX, STUDIO_FRAME_MIN_HEIGHT_PX } from '../limits'
import type { RequestResult } from './host'

export type ToastTone = 'info' | 'success' | 'error'

export interface HostEffects {
  setHeight(px: number): void
  /** False when the frame is over its toast budget. */
  toast(message: string, tone: ToastTone): boolean
}

export const clampFrameHeight = (height: number) =>
  Math.min(STUDIO_FRAME_MAX_HEIGHT_PX, Math.max(STUDIO_FRAME_MIN_HEIGHT_PX, height))

const INVALID: RequestResult = { ok: false, code: 'invalid', message: 'This request’s arguments aren’t valid.' }

export function runHostMethod(method: string, args: unknown, effects: HostEffects): RequestResult {
  if (method === 'ui.resize') {
    const parsed = parseMethodArgs(METHOD_CATALOG['ui.resize'], args)
    if (!parsed.ok) return INVALID
    const height = clampFrameHeight((parsed.args as { height: number }).height)
    effects.setHeight(height)
    return { ok: true, data: { height } }
  }
  if (method === 'ui.toast') {
    const parsed = parseMethodArgs(METHOD_CATALOG['ui.toast'], args)
    if (!parsed.ok) return INVALID
    const { message, tone } = parsed.args as { message: string; tone?: ToastTone }
    if (!effects.toast(message, tone ?? 'info')) {
      return { ok: false, code: 'rate_limited', message: 'Too many notifications. Wait a moment.' }
    }
    return { ok: true, data: null }
  }
  return { ok: false, code: 'unsupported', message: 'This tool asked for something Scholera doesn’t offer.' }
}
