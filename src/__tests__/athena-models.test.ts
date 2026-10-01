import { describe, it, expect } from 'vitest'
import {
  resolveAthenaModelDef,
  ATHENA_MODELS,
  DEFAULT_ATHENA_MODEL_ID,
} from '@/lib/ai/professor-assistant/models'

// resolveAthenaModelDef is the server-side whitelist that turns a client-supplied
// (untrusted) modelId into a known provider/model def in the assistant route.
// The load-bearing guarantee is that an unknown or missing id can NEVER select an
// arbitrary provider/model — it must fall back to the default. The cases below are
// that attack shape, not a restatement of the array.
describe('resolveAthenaModelDef', () => {
  const defaultDef = ATHENA_MODELS.find((m) => m.id === DEFAULT_ATHENA_MODEL_ID)!

  it('resolves a known id to its exact registry entry', () => {
    for (const m of ATHENA_MODELS) {
      expect(resolveAthenaModelDef(m.id)).toBe(m)
    }
  })

  it('falls back to the default for an unknown id', () => {
    expect(resolveAthenaModelDef('gpt-4o')).toBe(defaultDef)
    expect(resolveAthenaModelDef('../../etc/passwd')).toBe(defaultDef)
    expect(resolveAthenaModelDef('')).toBe(defaultDef)
  })

  it('falls back to the default for a missing id', () => {
    expect(resolveAthenaModelDef(undefined)).toBe(defaultDef)
  })

  it('never returns a provider/model outside the registry', () => {
    // The route maps the returned `provider` to an SDK and `model` to a model
    // string. Anything the resolver can return must already be whitelisted.
    const inputs = ['gemini-flash', 'unknown', '', undefined]
    for (const input of inputs) {
      const def = resolveAthenaModelDef(input)
      expect(ATHENA_MODELS).toContain(def)
    }
  })

  it('defaults to the Flash model (deliberate latency-first choice)', () => {
    // Flash (gemini-flash) is the intended default — a deliberate latency-first
    // call: at 'minimal' thinking it replies in ~0.5s vs Pro's ~9s. Since the
    // composer's model picker was removed there is no opt-in path any more: this
    // is the model EVERY surface asks for, and Pro is reachable only when Flash's
    // daily cap is spent and failoverCandidates hands over. That makes pinning the
    // default load-bearing rather than cosmetic.
    expect(DEFAULT_ATHENA_MODEL_ID).toBe('gemini-flash')
  })

  it('pins each model to its lowest thinking level (latency guard)', () => {
    // Gemini defaults to 'high' thinking, whose reasoning tokens are the
    // dominant latency in Athena. Flash's floor is 'minimal', Pro's is 'low'.
    // Pin both so an accidental bump back up (re-introducing ~9s replies) is
    // caught in review.
    const byId = Object.fromEntries(ATHENA_MODELS.map((m) => [m.id, m.thinkingLevel]))
    expect(byId['gemini-flash']).toBe('minimal')
    expect(byId['gemini-pro']).toBe('low')
  })
})
