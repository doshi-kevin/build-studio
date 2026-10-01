import 'server-only'

import { generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { TOPIC_EXTRACTION_MODEL } from '@/lib/ai/config'
import { logger } from '@/lib/logger'
import { recordAiUsage, type AiAttribution } from '@/lib/ai/usage'
import { mapOutputSchema, capLevel, type EvidenceCandidate, type Indicator, type Level, type MapMatch } from './types'
import type { CachedMatch } from './cache'

export interface MappedCandidate {
  candidate: EvidenceCandidate
  matches: Array<MapMatch & { indicator: Indicator }>
  /** False when the LLM call failed — such results must not be cached. */
  ok: boolean
}

/** Rebuild full matches from the cached shape (levels were capped before storing). */
export function matchesFromCached(
  cached: CachedMatch[],
  indicators: Indicator[],
): Array<MapMatch & { indicator: Indicator }> {
  const byCode = new Map(indicators.map((i) => [canonCode(i.code), i]))
  return cached
    .map((m) => {
      const indicator = byCode.get(canonCode(m.indicatorCode))
      return indicator ? { ...m, indicator } : null
    })
    .filter((m): m is MapMatch & { indicator: Indicator } => m !== null)
}

/** The lean, storable shape of a candidate's matches (indicator by canonical code). */
export function matchesToCached(matches: Array<MapMatch & { indicator: Indicator }>): CachedMatch[] {
  return matches.map((m) => ({
    indicatorCode: m.indicator.code,
    level: m.level as Level,
    justification: m.justification,
    confidence: m.confidence,
  }))
}

const SYSTEM = `You align a SINGLE piece of course material to a fixed list of ABET engineering performance indicators (PIs).

Rules:
- Map every PI the material clearly relates to. A design project maps to design PIs, a lab/data report to experimentation PIs, a written report to communication PIs, an ethics lecture to ethics PIs, a problem-solving lecture/quiz to problem-solving PIs, and so on. Include each relevant PI — don't be stingy. Only skip a PI when the material genuinely doesn't touch it; return an empty list only when nothing relates at all.
- Level: "I" = the material introduces/exposes the skill; "R" = it reinforces/practices it; "M" = it assesses mastery (graded work demonstrating the student can do it). Lectures are usually I or R; graded assignments and quizzes can be M.
- Never invent a PI code — use only codes from the provided list, exactly as written.
- Give a one-sentence justification grounded in the material, and a confidence (low/medium/high).
Return JSON matching the schema.`

function buildIndicatorList(indicators: Indicator[]): string {
  return indicators.map((i) => `${i.code} (${i.outcomeCode}): ${i.description}`).join('\n')
}

/**
 * Stage 2 — map ONE candidate to indicators via Gemini. The response is
 * validated against the schema, unknown PI codes are dropped, and each level
 * is clamped to the candidate's cap (enforcing "lectures cap at Reinforced").
 * A failed call contributes nothing rather than killing the whole run.
 */
// Match indicator codes tolerantly. The model often echoes the prompt's list
// format and returns e.g. "PI 4.1 (SO-4)" or "pi4.1" instead of the bare
// "PI 4.1". Canonicalize by extracting the PI token, so matching is robust to
// spacing, case, and a trailing "(SO-x)".
export const canonCode = (s: string) => (s.match(/PI\s*\d+\.\d+/i)?.[0] ?? s).replace(/\s+/g, '').toUpperCase()

export async function mapCandidate(
  candidate: EvidenceCandidate,
  indicators: Indicator[],
  attribution?: AiAttribution,
): Promise<MappedCandidate> {
  const byCode = new Map(indicators.map((i) => [canonCode(i.code), i]))
  try {
    const result = await generateObject({
      model: google(TOPIC_EXTRACTION_MODEL),
      system: SYSTEM,
      prompt: `Performance indicators:\n${buildIndicatorList(indicators)}\n\nMaterial (${candidate.sourceType} — "${candidate.title}"):\n${candidate.signal}`,
      schema: mapOutputSchema,
      temperature: 0.2,
      // No 'minimal' thinking here: matching content against ~19 indicators
      // needs real reasoning — minimal thinking returned mostly-empty, run-to-run
      // inconsistent results. Use the model's default reasoning budget.
    })
    void recordAiUsage({ feature: 'outcome_alignment', model: TOPIC_EXTRACTION_MODEL, ...attribution, usage: result.usage })
    const rawCodes = result.object.matches.map((m) => m.indicatorCode)
    const matches = result.object.matches
      .map((m) => {
        const indicator = byCode.get(canonCode(m.indicatorCode))
        return indicator ? { ...m, level: capLevel(m.level as Level, candidate.cap), indicator } : null
      })
      .filter((m): m is MapMatch & { indicator: Indicator } => m !== null)
    if (rawCodes.length !== matches.length) {
      logger.warn('outcome-alignment.mapCandidate: dropped unmatched codes', {
        title: candidate.title,
        returned: rawCodes,
        kept: matches.length,
      })
    }
    return { candidate, matches, ok: true }
  } catch (err) {
    logger.error('outcome-alignment.mapCandidate: LLM map failed', err, {
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
    })
    return { candidate, matches: [], ok: false }
  }
}
