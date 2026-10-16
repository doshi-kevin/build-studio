/**
 * The model, as the builder harness sees it: one call that takes instructions, a prompt
 * and tool declarations, and returns proposed tool calls. Nothing else. The harness
 * validates every call, runs every effect and decides every state; the model only
 * proposes (docs/reference/studio-agent-harness.md, "The model").
 *
 * `AgentModel` speaks in strings, tool declarations and plain results: no message
 * arrays, no provider options, no SDK types. Provider translation lives only in this file:
 * `createAnthropicModel` (production) and `createGeminiModel` (the Step 11 builder, kept
 * for the frozen evals). Neither falls back to the other.
 *
 * The adapter never throws for a model outcome (no tool call, an invalid call, a cut-off
 * reply, a timeout). It throws only when the call didn't happen (ModelUnavailable) or was
 * stopped (BuilderAbort).
 */
import 'server-only'
import { generateText, stepCountIs, tool, type ToolSet } from 'ai'
import { google } from '@ai-sdk/google'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { ANTHROPIC_FAST_MODEL_SUFFIX, STUDIO_BUILDER_ANTHROPIC_EFFORT, STUDIO_BUILDER_ANTHROPIC_MAX_OUTPUT_TOKENS, STUDIO_BUILDER_ANTHROPIC_MODEL, STUDIO_BUILDER_MODEL } from '@/lib/ai/config'
import { logger } from '@/lib/logger'

export interface ModelToolDecl {
  name: string
  description: string
  /** The same flat strict object the tool registry validates against. */
  inputSchema: z.ZodObject
}

export interface ModelUsage {
  /** The whole prompt, cached tokens included. */
  input: number
  cachedInput: number
  /** All billed output: text, tool-call arguments and thinking. */
  output: number
  /** The thinking share of `output`. Never shown or stored as text. 0 when the provider
   * doesn't report it separately: Anthropic bills thinking inside `output` with no split. */
  reasoning: number
}

/** A rendered screenshot for the design review. Bounded by the renderer and the harness
 * (STUDIO_BUILDER_REVIEW_IMAGE_*); it shows the plugin on synthetic data only. */
export interface ModelImage {
  label: string
  mediaType: 'image/jpeg' | 'image/png'
  bytes: Uint8Array
}

export interface ModelStepInput {
  system: string
  prompt: string
  /** Only the design review sends images. Each is preceded by its label in the message. */
  images?: ModelImage[]
  tools: ModelToolDecl[]
  maxOutputTokens: number
  abortSignal: AbortSignal
  timeoutMs: number
  /** How hard to think, for a model that has a setting for it; others ignore it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Fast mode, for a model that has it; others ignore it. Same model and effort, served faster. */
  speed?: 'fast'
}

export interface ModelStepResult {
  toolCalls: { name: string; input: unknown; invalid: boolean }[]
  /** Length only matters: free text is never parsed for state, stored or shown. */
  textLength: number
  finishReason: string
  timedOut: boolean
  usage: ModelUsage
  latencyMs: number
  modelId: string
}

export interface AgentModel {
  id: string
  /** The reply cap this model's builder turns use, when it differs from STUDIO_BUILDER_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number
  step(input: ModelStepInput): Promise<ModelStepResult>
}

/** The provider failed after its retries. The run ends failed (model_unavailable). */
export class ModelUnavailable extends Error {
  constructor() {
    super('model unavailable')
    this.name = 'ModelUnavailable'
  }
}

/** Stop or a lost claim aborted the call. */
export class BuilderAbort extends Error {
  constructor() {
    super('aborted')
    this.name = 'BuilderAbort'
  }
}

const ZERO: ModelUsage = { input: 0, cachedInput: 0, output: 0, reasoning: 0 }

/**
 * AI SDK v6 usage to builder usage. Same meaning as the shared ledger's TokenUsage
 * (src/lib/ai/cost.ts): the SDK's `outputTokens` already includes reasoning (Step 7B
 * probe: 135 = 20 text + 115 reasoning), so it is the billed output as is.
 */
export function mapUsage(usage: unknown): ModelUsage {
  if (!usage || typeof usage !== 'object') return ZERO
  const u = usage as {
    inputTokens?: number
    outputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  return {
    input: u.inputTokens ?? 0,
    cachedInput: u.inputTokenDetails?.cacheReadTokens ?? 0,
    output: u.outputTokens ?? 0,
    reasoning: u.outputTokenDetails?.reasoningTokens ?? 0,
  }
}

const isTimeout = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || /timed? ?out/i.test(error.message))

export function createGeminiModel(modelId = STUDIO_BUILDER_MODEL): AgentModel {
  return {
    id: modelId,
    async step(input) {
      const started = Date.now()
      // Declarations only: no `execute`, so the SDK runs nothing.
      const tools: ToolSet = Object.fromEntries(input.tools.map((t) => [t.name, tool({ description: t.description, inputSchema: t.inputSchema })]))
      const timeout = AbortSignal.timeout(input.timeoutMs)
      try {
        const images = input.images ?? []
        // Text-only turns keep the plain prompt; a turn with images sends one user message
        // whose parts are the prompt, then each label followed by its image.
        const content = images.length
          ? {
              messages: [
                {
                  role: 'user' as const,
                  content: [
                    { type: 'text' as const, text: input.prompt },
                    ...images.flatMap((img) => [
                      { type: 'text' as const, text: img.label },
                      { type: 'image' as const, image: img.bytes, mediaType: img.mediaType },
                    ]),
                  ],
                },
              ],
            }
          : { prompt: input.prompt }
        const res = await generateText({
          model: google(modelId),
          system: input.system,
          ...content,
          tools,
          toolChoice: 'required',
          // One step: the harness runs the loop, one turn per call, under its own budgets.
          stopWhen: stepCountIs(1),
          maxOutputTokens: input.maxOutputTokens,
          maxRetries: 2,
          abortSignal: AbortSignal.any([input.abortSignal, timeout]),
          providerOptions: {
            google: {
              thinkingConfig: { thinkingLevel: 'low', includeThoughts: false },
              // Fixes what each screenshot costs (STUDIO_BUILDER_REVIEW_IMAGE_TOKENS).
              ...(images.length ? { mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' } : {}),
            },
          },
        })
        return {
          toolCalls: res.toolCalls.map((c) => ({ name: c.toolName, input: c.input, invalid: (c as { invalid?: boolean }).invalid === true })),
          textLength: res.text.length,
          finishReason: res.finishReason,
          timedOut: false,
          usage: mapUsage(res.usage),
          latencyMs: Date.now() - started,
          modelId,
        }
      } catch (error) {
        if (input.abortSignal.aborted) throw new BuilderAbort()
        if (timeout.aborted || isTimeout(error)) {
          return { toolCalls: [], textLength: 0, finishReason: 'timeout', timedOut: true, usage: ZERO, latencyMs: Date.now() - started, modelId }
        }
        // Name and HTTP status only: a provider message can quote the request.
        const e = error as { name?: unknown; statusCode?: unknown; cause?: { name?: unknown } }
        logger.warn('studio.builder.model.unavailable', {
          name: typeof e?.name === 'string' ? e.name : 'unknown',
          status: typeof e?.statusCode === 'number' ? e.statusCode : null,
          cause: typeof e?.cause?.name === 'string' ? e.cause.name : null,
          ms: Date.now() - started,
        })
        throw new ModelUnavailable()
      }
    },
  }
}

// ── Anthropic ──

/** What the adapter needs of the SDK client; tests pass a stand-in. */
export interface AnthropicClientLike {
  messages: {
    stream(params: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }): { finalMessage(): Promise<Anthropic.Message> }
  }
  /** Fast mode is on the beta endpoint. Without it, a fast request is sent at standard speed. */
  beta?: {
    messages: {
      // The beta types differ only in names; the request is the standard one plus speed and betas.
      stream(params: never, options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }): { finalMessage(): Promise<unknown> }
    }
  }
}

/** The beta flag fast mode needs. */
const FAST_MODE_BETA = 'fast-mode-2026-02-01'

/** Anthropic usage to builder usage. `input_tokens` excludes cache reads and writes, so the
 * whole prompt is their sum. Thinking is billed inside `output_tokens` with no separate count,
 * so `reasoning` is 0 (not reported), never an estimate; the cost is right either way. */
export function anthropicUsage(usage: Partial<Anthropic.Usage> | null | undefined): ModelUsage {
  if (!usage) return ZERO
  const read = usage.cache_read_input_tokens ?? 0
  return {
    input: (usage.input_tokens ?? 0) + read + (usage.cache_creation_input_tokens ?? 0),
    cachedInput: read,
    output: usage.output_tokens ?? 0,
    reasoning: 0,
  }
}

/** Anthropic's stop reasons in the vocabulary the harness reads ('length' means cut off). */
const FINISH: Record<string, string> = { tool_use: 'tool-calls', end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', refusal: 'refusal', pause_turn: 'pause' }

export function createAnthropicModel(
  modelId = STUDIO_BUILDER_ANTHROPIC_MODEL,
  effort = STUDIO_BUILDER_ANTHROPIC_EFFORT,
  client?: AnthropicClientLike,
): AgentModel {
  return {
    id: modelId,
    maxOutputTokens: STUDIO_BUILDER_ANTHROPIC_MAX_OUTPUT_TOKENS,
    async step(input) {
      const started = Date.now()
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!client && !apiKey) {
        // A configuration fault, not a model outcome: the run ends model_unavailable, and
        // nothing falls back to another provider.
        logger.error('studio.builder.model.no_key: ANTHROPIC_API_KEY is not set', { model: modelId })
        throw new ModelUnavailable()
      }
      const anthropic = client ?? new Anthropic({ apiKey, maxRetries: 2 })
      let timeout = AbortSignal.timeout(input.timeoutMs)
      // Whether the attempt in flight is fast mode, so a cut-off call is priced at its own row.
      let fast = input.speed === 'fast' && Boolean(anthropic.beta)
      // The same flat strict schemas the tool registry validates against; nothing runs here.
      const tools: Anthropic.Tool[] = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: z.toJSONSchema(t.inputSchema) as Anthropic.Tool.InputSchema,
      }))
      const images = input.images ?? []
      const content: Anthropic.ContentBlockParam[] = [
        { type: 'text', text: input.prompt },
        ...images.flatMap((img): Anthropic.ContentBlockParam[] => [
          { type: 'text', text: img.label },
          { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: Buffer.from(img.bytes).toString('base64') } },
        ]),
      ]
      try {
        const params: Anthropic.MessageStreamParams = {
          model: modelId,
          max_tokens: input.maxOutputTokens,
          system: input.system,
          messages: [{ role: 'user', content }],
          tools,
          // Forced tool choice isn't accepted on this model: the instructions require a
          // call, and a turn without one is refused by the harness like any other.
          tool_choice: { type: 'auto' },
          output_config: { effort: input.effort ?? effort },
        }
        const send = (asFast: boolean) => {
          const signal = AbortSignal.any([input.abortSignal, timeout])
          // A fast attempt isn't retried by the SDK: its rate limit goes straight to standard speed.
          return asFast && anthropic.beta
            ? (anthropic.beta.messages.stream({ ...params, speed: 'fast', betas: [FAST_MODE_BETA] } as never, { signal, maxRetries: 0 }).finalMessage() as Promise<Anthropic.Message>)
            : anthropic.messages.stream(params, { signal }).finalMessage()
        }
        let res: Anthropic.Message
        try {
          res = await send(fast)
        } catch (error) {
          // Fast mode has its own rate limit: the same request again at standard speed, same model,
          // with a timeout of its own.
          if (!(fast && error instanceof Anthropic.RateLimitError) || input.abortSignal.aborted || timeout.aborted) throw error
          logger.info('studio.builder.model.fast_rate_limited: sending at standard speed', { model: modelId })
          fast = false
          timeout = AbortSignal.timeout(input.timeoutMs)
          // At standard speed the standard cap: a fast-mode reply cap wouldn't stream within the timeout.
          params.max_tokens = Math.min(params.max_tokens, STUDIO_BUILDER_ANTHROPIC_MAX_OUTPUT_TOKENS)
          res = await send(false)
        }
        const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        return {
          // Arguments that aren't an object can't be a tool's input: marked invalid, refused by the harness.
          toolCalls: calls.map((c) => ({ name: c.name, input: c.input, invalid: typeof c.input !== 'object' || c.input === null || Array.isArray(c.input) })),
          textLength: res.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0),
          finishReason: FINISH[res.stop_reason ?? ''] ?? String(res.stop_reason ?? 'unknown'),
          timedOut: false,
          usage: anthropicUsage(res.usage),
          latencyMs: Date.now() - started,
          // The id asked for, not res.model: cost is priced by exact id, and a dated id would miss its
          // rate row. A fast-mode call is priced at its own row.
          modelId: fast ? `${modelId}${ANTHROPIC_FAST_MODEL_SUFFIX}` : modelId,
        }
      } catch (error) {
        if (input.abortSignal.aborted) throw new BuilderAbort()
        if (timeout.aborted || isTimeout(error)) {
          return { toolCalls: [], textLength: 0, finishReason: 'timeout', timedOut: true, usage: ZERO, latencyMs: Date.now() - started, modelId: fast ? `${modelId}${ANTHROPIC_FAST_MODEL_SUFFIX}` : modelId }
        }
        // Name and HTTP status only: a provider message can quote the request.
        logger.warn('studio.builder.model.unavailable', {
          name: error instanceof Error ? error.name : 'unknown',
          status: error instanceof Anthropic.APIError && typeof error.status === 'number' ? error.status : null,
          ms: Date.now() - started,
        })
        throw new ModelUnavailable()
      }
    },
  }
}
