/**
 * The model, as the builder harness sees it: one call that takes instructions, a prompt
 * and tool declarations, and returns proposed tool calls. Nothing else. The harness
 * validates every call, runs every effect and decides every state; the model only
 * proposes (docs/reference/studio-agent-harness.md, "The model").
 *
 * `AgentModel` speaks in strings, tool declarations and plain results: no message
 * arrays, no provider options, no SDK types. Gemini-specific translation lives only in
 * `createGeminiModel`, the one builder module that imports a provider SDK.
 *
 * The adapter never throws for a model outcome (no tool call, an invalid call, a cut-off
 * reply, a timeout). It throws only when the call didn't happen (ModelUnavailable) or was
 * stopped (BuilderAbort).
 */
import 'server-only'
import { generateText, stepCountIs, tool, type ToolSet } from 'ai'
import { google } from '@ai-sdk/google'
import type { z } from 'zod'
import { STUDIO_BUILDER_MODEL } from '@/lib/ai/config'

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
  /** The thinking share of `output`. Never shown or stored as text. */
  reasoning: number
}

export interface ModelStepInput {
  system: string
  prompt: string
  tools: ModelToolDecl[]
  maxOutputTokens: number
  abortSignal: AbortSignal
  timeoutMs: number
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
        const res = await generateText({
          model: google(modelId),
          system: input.system,
          prompt: input.prompt,
          tools,
          toolChoice: 'required',
          // One step: the harness runs the loop, one turn per call, under its own budgets.
          stopWhen: stepCountIs(1),
          maxOutputTokens: input.maxOutputTokens,
          maxRetries: 2,
          abortSignal: AbortSignal.any([input.abortSignal, timeout]),
          providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: false } } },
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
        throw new ModelUnavailable()
      }
    },
  }
}
