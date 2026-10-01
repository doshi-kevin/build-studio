import { describe, expect, it } from 'vitest'
import { parseManifest, parseManifestFile } from '@/lib/studio/manifest'
import { CAPABILITIES } from '@/lib/studio/capabilities'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'

/** Issues from parsing the example manifest after setting one dotted path in it.
 * `undefined` deletes the key. */
function issuesAfter(path: string, value: unknown): string[] {
  const draft = structuredClone(exitTicket) as Record<string, unknown>
  const keys = path.split('.')
  const last = keys.pop()!
  const parent = keys.reduce((obj, key) => obj[key] as Record<string, unknown>, draft)
  if (value === undefined) delete parent[last]
  else parent[last] = value
  const result = parseManifest(draft)
  expect(result.ok).toBe(false)
  return result.ok ? [] : result.issues
}

const studentCaps = exitTicket.views.student.capabilities

describe('a valid manifest', () => {
  it('accepts the example exit ticket', () => {
    const result = parseManifest(exitTicket)
    expect(result).toMatchObject({ ok: true, manifest: { id: 'exit-ticket', version: '1.0.0' } })
  })

  it('accepts a plugin that stores no data', () => {
    expect(parseManifest({ ...exitTicket, collections: {} }).ok).toBe(true)
  })
})

describe('views (both are mandatory, rule 9.4)', () => {
  it('rejects a missing student view', () => {
    expect(issuesAfter('views.student', undefined)).toEqual(['views.student: Every plugin needs a student view'])
  })

  it('rejects a missing professor view', () => {
    expect(issuesAfter('views.professor', undefined)).toEqual(['views.professor: Every plugin needs a professor view'])
  })

  it('rejects a view for a role Scholera does not have', () => {
    expect(issuesAfter('views.admin', exitTicket.views.professor)).toEqual([expect.stringMatching(/^views: .*admin/)])
  })

  it.each(['../secrets.tsx', '/views/student.tsx', 'https://evil.example/x.tsx', 'views\\student.tsx', 'views/student.js'])(
    'rejects entry %s, which is not a relative .tsx path inside the plugin',
    (entry) => {
      expect(issuesAfter('views.student.entry', entry)).toEqual([expect.stringMatching(/^views\.student\.entry: /)])
    },
  )
})

describe('version', () => {
  it.each(['1.0', 'v1.0.0', '01.0.0', '1.0.0-beta', ''])('rejects %j', (version) => {
    expect(issuesAfter('version', version)).toEqual(['version: Must be a version like 1.0.0'])
  })

  it('rejects a version written as a number', () => {
    expect(issuesAfter('version', 1)).toEqual([expect.stringMatching(/^version: /)])
  })

  it('rejects a bridge version the platform does not serve', () => {
    expect(issuesAfter('bridgeVersion', 'v2')).toEqual([expect.stringMatching(/^bridgeVersion: /)])
  })

  it.each([0, 3, '1'])('rejects manifest format %j, which it does not know', (manifestVersion) => {
    expect(issuesAfter('manifestVersion', manifestVersion)).toEqual(['manifestVersion: Must be 1 or 2'])
  })

  it('reads a version 1 manifest as version 1, never as version 2', () => {
    expect(issuesAfter('manifestVersion', 2)).toEqual(expect.arrayContaining([expect.stringMatching(/^purpose: /)]))
  })
})

describe('capabilities', () => {
  it('rejects a capability the bridge does not have', () => {
    expect(issuesAfter('views.student.capabilities', [...studentCaps, 'network.fetch'])).toEqual([
      expect.stringMatching(/^views\.student\.capabilities\.2: /),
    ])
  })

  it('rejects class-wide data in the student view (rules 4.1, 4.5)', () => {
    expect(issuesAfter('views.student.capabilities', [...studentCaps, 'course.weakSpots'])).toEqual([
      'views.student.capabilities.2: course.weakSpots isn’t available in the student view',
    ])
  })

  it('every capability has a label a professor can read and at least one view', () => {
    for (const c of Object.values(CAPABILITIES)) {
      expect(c.label.length).toBeGreaterThan(5)
      expect(c.views.length).toBeGreaterThan(0)
    }
  })
})

describe('collections', () => {
  it.each(['studentId', 'institutionId', 'userID', 'id'])('rejects a field named %s, which the platform stamps', (name) => {
    expect(issuesAfter(`collections.responses.fields.${name}`, 'text')).toEqual([
      `collections.responses.fields.${name}: ${name} is stamped by the platform and can’t be declared`,
    ])
  })

  it('rejects an unknown field type', () => {
    expect(issuesAfter('collections.responses.fields.answer', 'html')).toEqual([
      expect.stringMatching(/^collections\.responses\.fields\.answer: /),
    ])
  })

  it('rejects an unknown access rule', () => {
    expect(issuesAfter('collections.responses.access', 'public')).toEqual([
      expect.stringMatching(/^collections\.responses\.access: /),
    ])
  })

  it('rejects a collection with no fields', () => {
    expect(issuesAfter('collections.responses.fields', {})).toEqual([
      'collections.responses.fields: A collection needs at least one field',
    ])
  })

  it('rejects a collection name that is not camelCase', () => {
    expect(issuesAfter('collections.__proto__x', exitTicket.collections.responses)).toEqual([
      expect.stringMatching(/^collections\.__proto__x: /),
    ])
  })

  // z.record drops a "__proto__" key without an error, so without the raw-key check this
  // manifest would parse with its responses collection silently missing.
  it('rejects a collection named __proto__ instead of dropping it', () => {
    const text = JSON.stringify(exitTicket).replace('"responses":', '"__proto__":')
    expect(parseManifestFile(text)).toEqual({
      ok: false,
      issues: ['collections.__proto__: collection names are camelCase letters and digits, starting lowercase'],
    })
  })
})

describe('malformed data', () => {
  // Each case is wrapped in its own array: it.each spreads an array case into arguments.
  it.each([[null], [undefined], ['exit-ticket'], [42], [[]], [{}]])('rejects %j', (raw) => {
    expect(parseManifest(raw).ok).toBe(false)
  })

  it('rejects fields it does not define, so a manifest cannot smuggle in who or where (rule 2.1)', () => {
    expect(issuesAfter('institutionId', '00000000-0000-0000-0000-000000000000')).toEqual([
      expect.stringMatching(/institutionId/),
    ])
  })

  it('rejects text that is not JSON', () => {
    expect(parseManifestFile('{ "id": "exit-ticket", ')).toEqual({ ok: false, issues: ['plugin.manifest.json is not valid JSON'] })
  })

  it('parses the same file text the builder writes', () => {
    expect(parseManifestFile(JSON.stringify(exitTicket)).ok).toBe(true)
  })
})
