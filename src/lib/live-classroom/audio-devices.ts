'use client'

/**
 * Microphone selection for the live classroom (e.g. a Hollyland Lark A1
 * wireless mic next to the MacBook's built-in one). One stored preference
 * drives BOTH capture pipelines — transcription (use-transcription) and the
 * class recording (use-recording-capture) — which stay deliberately separate
 * streams.
 *
 * Persistence is localStorage, not the DB (same rationale as
 * use-sidebar-rail.ts): a per-browser hardware preference with no
 * tenant/security implications. Stored as {deviceId, label} because Chrome
 * rotates deviceIds across sessions/profiles — when the id no longer matches,
 * we fall back to matching the label, then to the browser default.
 *
 * Browser constraints applied at resolve time:
 *   • Device labels are EMPTY until mic permission is granted — callers that
 *     show a picker should prime permission first (requestMicAccess).
 *   • External mics (like the Lark) do their own noise-cancel DSP on-device;
 *     stacking Chrome's software processing on top degrades what the STT
 *     model hears, so we disable it for them. The built-in mic keeps the
 *     software processing exactly as before.
 */

import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'scholera_lc_mic_pref'
const PREF_EVENT = 'scholera:lc-mic-pref'

export interface MicPref {
  deviceId: string
  label: string
}

export function getStoredMicPref(): MicPref | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as MicPref
    if (typeof parsed?.deviceId !== 'string' || typeof parsed?.label !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** Pass null to clear the preference (= use the browser default). */
export function setStoredMicPref(pref: MicPref | null) {
  if (typeof window === 'undefined') return
  try {
    if (pref) localStorage.setItem(STORAGE_KEY, JSON.stringify(pref))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable — the preference just won't persist */
  }
  // Notify same-tab listeners; the native 'storage' event only fires cross-tab.
  window.dispatchEvent(new CustomEvent(PREF_EVENT))
}

/** Built-in mics keep Chrome's software audio processing; external ones
 *  (hardware DSP) get it disabled. Label heuristic — good enough for the
 *  constraint choice, harmless when wrong. */
export function isBuiltInMicLabel(label: string): boolean {
  return /built-in|internal|macbook/i.test(label)
}

/** Resolve the stored preference against the current device list.
 *  Returns the deviceId to request, or null for the browser default. */
export function resolveMicDeviceId(
  pref: MicPref | null,
  devices: Pick<MediaDeviceInfo, 'deviceId' | 'label'>[],
): string | null {
  if (!pref) return null
  const byId = devices.find((d) => d.deviceId === pref.deviceId)
  if (byId) return byId.deviceId
  // deviceIds rotate across sessions — fall back to the human-stable label.
  const byLabel = pref.label
    ? devices.find((d) => d.label.toLowerCase() === pref.label.toLowerCase())
    : undefined
  return byLabel?.deviceId ?? null
}

/** Audio constraints for a resolved device (null = browser default, which
 *  keeps today's exact behavior). Exported for tests. */
export function buildMicConstraints(
  resolved: { deviceId: string; label: string } | null,
): MediaTrackConstraints {
  if (!resolved) {
    return { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  }
  const builtIn = isBuiltInMicLabel(resolved.label)
  return {
    deviceId: { exact: resolved.deviceId },
    channelCount: 1,
    echoCancellation: builtIn,
    noiseSuppression: builtIn,
    ...(builtIn ? {} : { autoGainControl: false }),
  }
}

/** One-stop resolve for the capture hooks: stored pref → device list →
 *  constraints. Never throws; any failure returns the default constraints. */
export async function getPreferredMicConstraints(): Promise<MediaTrackConstraints> {
  const pref = getStoredMicPref()
  if (!pref) return buildMicConstraints(null)
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter((d) => d.kind === 'audioinput')
    const deviceId = resolveMicDeviceId(pref, inputs)
    if (!deviceId) return buildMicConstraints(null)
    const label = inputs.find((d) => d.deviceId === deviceId)?.label ?? pref.label
    return buildMicConstraints({ deviceId, label })
  } catch {
    return buildMicConstraints(null)
  }
}

/** Prime mic permission so enumerateDevices returns real labels: a brief
 *  default-device grab, released immediately. Returns false when denied. */
export async function requestMicAccess(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
    return true
  } catch {
    return false
  }
}

export interface UseAudioInputDevicesResult {
  /** Audio inputs, refreshed on devicechange. Labels are '' until permission. */
  devices: MediaDeviceInfo[]
  /** True once at least one device label is readable (permission granted). */
  hasLabels: boolean
  /** The stored preference (reactive across components/tabs). */
  pref: MicPref | null
  /** Persist a device choice (null = browser default). */
  select: (device: { deviceId: string; label: string } | null) => void
  /** Prime permission (populates labels), then re-enumerate. */
  requestAccess: () => Promise<boolean>
}

export function useAudioInputDevices(): UseAudioInputDevicesResult {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [pref, setPref] = useState<MicPref | null>(null)

  const refresh = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices(all.filter((d) => d.kind === 'audioinput'))
    } catch {
      setDevices([])
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPref(getStoredMicPref())
    void refresh()
    const syncPref = () => setPref(getStoredMicPref())
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    window.addEventListener(PREF_EVENT, syncPref)
    window.addEventListener('storage', syncPref)
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
      window.removeEventListener(PREF_EVENT, syncPref)
      window.removeEventListener('storage', syncPref)
    }
  }, [refresh])

  const select = useCallback((device: { deviceId: string; label: string } | null) => {
    const next = device ? { deviceId: device.deviceId, label: device.label } : null
    setStoredMicPref(next)
    setPref(next)
  }, [])

  const requestAccess = useCallback(async () => {
    const ok = await requestMicAccess()
    await refresh()
    return ok
  }, [refresh])

  return { devices, hasLabels: devices.some((d) => d.label !== ''), pref, select, requestAccess }
}
