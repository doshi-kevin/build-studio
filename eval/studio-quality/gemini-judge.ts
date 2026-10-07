/**
 * A live judge on Gemini, the only model family with a dedicated non-production key on this
 * project. Configured to be stronger than the Step 11 builder it judges: the builder runs
 * gemini-3.1-pro-preview at thinking "low", so the same model at "low" is refused here.
 *
 * Replies are plain JSON (no provider-side schema: Gemini's schema subset can't express the
 * protocol's id patterns); judge.ts validates every reply itself. Each call's worst case is
 * fixed from its token caps, so the spend cap can reserve it before the call, and a prompt
 * that could exceed the input cap is refused before it is sent.
 */
import { generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { computeCostUsd, isPricedModel, RATES_DATED } from '../../src/lib/ai/cost'
import { STUDIO_BUILDER_MODEL } from '../../src/lib/ai/config'
import { mapUsage } from '../../src/lib/studio/builder/model'
import { JUDGE_PROMPT_VERSION, type JudgeModel, type JudgeRequest } from './judge'

export const GEMINI_JUDGE_LEVELS = ['medium', 'high'] as const
export type GeminiThinking = (typeof GEMINI_JUDGE_LEVELS)[number]

/** Input the judge may send in one call; a longer prompt is refused, never truncated. */
export const JUDGE_MAX_INPUT_TOKENS = 64_000
/** Output, thinking included. */
export const JUDGE_MAX_OUTPUT_TOKENS = 32_768
/** What one screenshot costs at high media resolution, counted on the high side. */
export const JUDGE_IMAGE_TOKENS = 1_200
const CALL_TIMEOUT_MS = 300_000

/** A conservative token count for a prompt: two and a half characters a token (source and JSON run dense), plus the images and the id sent before each. */
export const estimateInputTokens = (request: Pick<JudgeRequest, 'system' | 'prompt' | 'images'>) =>
  Math.ceil((request.system.length + request.prompt.length + request.images.reduce((n, i) => n + i.id.length, 0)) / 2.5) + request.images.length * JUDGE_IMAGE_TOKENS

export interface GeminiJudgeConfig {
  model: string
  thinking: string | null
}

/** Every reason this configuration can't be a judge, or none. */
export function geminiJudgeProblems(config: GeminiJudgeConfig, env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = []
  // Calibrated only as the builder's own model thinking harder than its low; a smaller model isn't stronger.
  if (!isPricedModel(config.model)) problems.push(`${config.model} has no price in src/lib/ai/cost.ts, so its spend can't be capped`)
  else if (config.model !== STUDIO_BUILDER_MODEL) problems.push(`${config.model} isn't the calibrated judge model ${STUDIO_BUILDER_MODEL}; the judge must be stronger than the builder it judges`)
  if (!config.thinking) problems.push('name the judge’s thinking level with --judge-reasoning=medium|high')
  else if (config.thinking === 'low') problems.push('thinking low is the builder’s own configuration; the judge must be stronger than the builder it judges')
  else if (!(GEMINI_JUDGE_LEVELS as readonly string[]).includes(config.thinking)) problems.push(`thinking level ${config.thinking} is not one of ${GEMINI_JUDGE_LEVELS.join(', ')}`)
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) problems.push('GOOGLE_GENERATIVE_AI_API_KEY is not set; export the dedicated non-production key')
  return problems
}

export function createGeminiJudge(config: GeminiJudgeConfig): JudgeModel {
  const problems = geminiJudgeProblems(config)
  if (problems.length) throw new Error(`The Gemini judge can't start: ${problems.join('; ')}.`)
  const thinking = config.thinking as GeminiThinking
  const worstCaseCallUsd = computeCostUsd(config.model, { inputTokens: JUDGE_MAX_INPUT_TOKENS, outputTokens: JUDGE_MAX_OUTPUT_TOKENS })
  return {
    identity: {
      kind: 'live',
      provider: 'google',
      model: config.model,
      reasoning: `thinkingLevel=${thinking}`,
      config: {
        thinkingLevel: thinking,
        mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
        maxInputTokens: JUDGE_MAX_INPUT_TOKENS,
        replyFormat: 'json, validated by the protocol',
        ratesDated: RATES_DATED,
        builderModel: STUDIO_BUILDER_MODEL,
        builderThinking: 'low',
      },
      promptVersion: JUDGE_PROMPT_VERSION,
    },
    worstCaseCallUsd,
    async ask(request) {
      const estimate = estimateInputTokens(request)
      if (estimate > JUDGE_MAX_INPUT_TOKENS) throw Object.assign(new Error(`prompt too long for the judge (about ${estimate} tokens)`), { costUsd: 0 })
      try {
        const { object, usage } = await generateObject({
          model: google(config.model),
          output: 'no-schema',
          system: request.system,
          // Screenshots first, then the text: the shared part of every call on one artifact
          // comes before anything pass-specific, so it can be served from the prompt cache.
          messages: [
            {
              role: 'user',
              content: [
                ...request.images.flatMap((img) => [
                  { type: 'text' as const, text: img.id },
                  { type: 'image' as const, image: img.bytes, mediaType: img.mediaType },
                ]),
                { type: 'text' as const, text: request.prompt },
              ],
            },
          ],
          maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          providerOptions: { google: { thinkingConfig: { thinkingLevel: thinking, includeThoughts: false }, mediaResolution: 'MEDIA_RESOLUTION_HIGH' } },
        })
        return { output: object, costUsd: costFor(config.model, usage) }
      } catch (error) {
        // Name and status only: a provider message can quote the request.
        const e = error as { name?: unknown; statusCode?: unknown; usage?: unknown }
        const name = typeof e?.name === 'string' ? e.name : 'Error'
        const status = typeof e?.statusCode === 'number' ? ` ${e.statusCode}` : ''
        throw Object.assign(new Error(`${name}${status}`), { costUsd: e?.usage ? costFor(config.model, e.usage) : null })
      }
    },
  }
}

function costFor(model: string, usage: unknown): number {
  const u = mapUsage(usage)
  return computeCostUsd(model, { inputTokens: u.input, cachedInputTokens: u.cachedInput, outputTokens: u.output, reasoningTokens: u.reasoning })
}
