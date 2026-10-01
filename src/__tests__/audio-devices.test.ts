// Mic preference resolution for the live classroom (audio-devices.ts):
// stored {deviceId,label} → the device to request. deviceIds rotate across
// browser sessions, so label fallback is the load-bearing path; constraints
// disable Chrome's software DSP for external mics (hardware noise-cancel)
// while the built-in mic keeps the pre-picker behavior exactly.

import { describe, it, expect } from 'vitest'
import {
  resolveMicDeviceId,
  buildMicConstraints,
  isBuiltInMicLabel,
} from '@/lib/live-classroom/audio-devices'

const builtIn = { deviceId: 'id-builtin', label: 'MacBook Pro Microphone (Built-in)' }
const lark = { deviceId: 'id-lark', label: 'HOLLYLAND LARK A1' }

describe('resolveMicDeviceId', () => {
  it('returns null (browser default) when no preference is stored', () => {
    expect(resolveMicDeviceId(null, [builtIn, lark])).toBeNull()
  })

  it('matches by exact deviceId when the device is present', () => {
    expect(resolveMicDeviceId({ deviceId: 'id-lark', label: 'HOLLYLAND LARK A1' }, [builtIn, lark])).toBe('id-lark')
  })

  it('falls back to a case-insensitive label match when the deviceId rotated', () => {
    const pref = { deviceId: 'stale-id-from-last-session', label: 'hollyland lark a1' }
    expect(resolveMicDeviceId(pref, [builtIn, lark])).toBe('id-lark')
  })

  it('returns null when the preferred device is not connected', () => {
    const pref = { deviceId: 'id-lark', label: 'HOLLYLAND LARK A1' }
    expect(resolveMicDeviceId(pref, [builtIn])).toBeNull()
  })

  it('never label-matches on an empty label (pre-permission lists)', () => {
    const pref = { deviceId: 'stale-id', label: '' }
    expect(resolveMicDeviceId(pref, [{ deviceId: 'id-x', label: '' }])).toBeNull()
  })
})

describe('buildMicConstraints', () => {
  it('default (null) keeps the original pipeline constraints', () => {
    expect(buildMicConstraints(null)).toEqual({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    })
  })

  it('external mic: exact deviceId, software DSP off (hardware does it)', () => {
    const c = buildMicConstraints(lark)
    expect(c.deviceId).toEqual({ exact: 'id-lark' })
    expect(c.echoCancellation).toBe(false)
    expect(c.noiseSuppression).toBe(false)
    expect(c.autoGainControl).toBe(false)
    expect(c.channelCount).toBe(1)
  })

  it('explicitly selected built-in mic keeps software DSP on', () => {
    const c = buildMicConstraints(builtIn)
    expect(c.deviceId).toEqual({ exact: 'id-builtin' })
    expect(c.echoCancellation).toBe(true)
    expect(c.noiseSuppression).toBe(true)
    expect(c.autoGainControl).toBeUndefined()
  })
})

describe('isBuiltInMicLabel', () => {
  it.each([
    ['MacBook Pro Microphone (Built-in)', true],
    ['Built-in Microphone', true],
    ['Internal Microphone', true],
    ['HOLLYLAND LARK A1', false],
    ['USB Audio Device', false],
    ['', false],
  ])('%s → %s', (label, expected) => {
    expect(isBuiltInMicLabel(label)).toBe(expected)
  })
})
