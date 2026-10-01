import { describe, expect, it } from 'vitest'
import { STUDIO_RECORD_MAX_BYTES } from '@/lib/studio/limits'
import { validateRecordData, type CollectionDef } from '@/lib/studio/record-schema'

const RESPONSES: CollectionDef = {
  access: 'perStudent',
  fields: { answer: 'text', confidence: 'number', done: 'boolean' },
}
const VALID = { answer: 'The base case', confidence: 3, done: false }

const check = (raw: unknown) => validateRecordData('v1', 'responses', RESPONSES, raw)
// Schemas are cached by (version, collection), which is safe only because a version
// never changes. A different shape therefore needs its own version and name here.
const checkPair = (raw: unknown) =>
  validateRecordData('v2', 'pair', { access: 'shared', fields: { a: 'text', b: 'text' } }, raw)

describe('manifest fields to runtime validation', () => {
  it('accepts a record with every declared field, returning it unchanged', () => {
    expect(check(VALID)).toEqual({ ok: true, data: VALID })
  })

  it('keeps an empty string as written', () => {
    expect(check({ ...VALID, answer: '' })).toEqual({ ok: true, data: { ...VALID, answer: '' } })
  })

  it.each([
    ['a missing field', { answer: 'x', confidence: 1 }, /^done: /],
    ['null for a text field', { ...VALID, answer: null }, /^answer: /],
    ['a string for a number', { ...VALID, confidence: '3' }, /^confidence: /],
    ['NaN', { ...VALID, confidence: Number.NaN }, /^confidence: /],
    ['Infinity', { ...VALID, confidence: Number.POSITIVE_INFINITY }, /^confidence: /],
    ['a number for a boolean', { ...VALID, done: 1 }, /^done: /],
    ['a nested object for text', { ...VALID, answer: { html: '<b>x</b>' } }, /^answer: /],
  ])('rejects %s', (_label, raw, issue) => {
    const result = check(raw)
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.issues).toEqual([expect.stringMatching(issue)])
  })

  it('rejects fields the collection does not declare, including platform stamps', () => {
    expect(check({ ...VALID, studentId: 'someone-else' })).toEqual({
      ok: false,
      issues: ['studentId: not a field of responses'],
    })
  })

  // z.strictObject accepts an own "__proto__" key from JSON.parse without reporting it,
  // so without the raw-key check this would pass with the key silently dropped.
  it('rejects a __proto__ key instead of dropping it', () => {
    const raw = JSON.parse('{"answer":"x","confidence":1,"done":true,"__proto__":{"isAdmin":true}}')
    expect(check(raw)).toEqual({ ok: false, issues: ['__proto__: not a field of responses'] })
  })

  it.each([
    ['null', null],
    ['an array', [VALID]],
    ['a string', '{"answer":"x"}'],
    ['a number', 7],
    ['a Date', new Date()],
    ['a Map', new Map(Object.entries(VALID))],
    ['a class instance', Object.assign(Object.create({ inherited: true }), VALID)],
  ])('rejects %s as record data', (_label, raw) => {
    expect(check(raw).ok).toBe(false)
  })
})

describe('size limit', () => {
  it('rejects one field longer than the record limit, before measuring the record', () => {
    const result = check({ ...VALID, answer: 'x'.repeat(STUDIO_RECORD_MAX_BYTES + 1) })
    expect(result.ok ? [] : result.issues).toEqual([expect.stringMatching(/^answer: /)])
  })

  it('rejects a record whose fields each fit but together exceed the limit', () => {
    const half = 'x'.repeat(STUDIO_RECORD_MAX_BYTES / 2)
    expect(checkPair({ a: half, b: half })).toEqual({ ok: false, issues: ['Record is larger than 16 KiB'] })
  })

  it('accepts a record just under the limit', () => {
    const fits = 'x'.repeat(STUDIO_RECORD_MAX_BYTES / 2 - 20)
    expect(checkPair({ a: fits, b: fits }).ok).toBe(true)
  })

  it('measures bytes, not characters', () => {
    // 3 bytes per character in UTF-8, so this is under the limit in characters but over it in bytes.
    const wide = '€'.repeat(Math.ceil(STUDIO_RECORD_MAX_BYTES / 3) + 1)
    expect(checkPair({ a: wide, b: '' })).toEqual({ ok: false, issues: ['Record is larger than 16 KiB'] })
  })
})
