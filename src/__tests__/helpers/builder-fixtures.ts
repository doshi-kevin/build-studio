/**
 * Builder test fixtures: a flashcards tool that passes the whole draft gate, written the
 * way the builder's instructions ask (items in a collection read at run time, the three
 * kit states, nothing but kit components), and the scripted-model helpers the harness
 * tests drive it with.
 */
import { compileView } from '@/lib/studio/builder/compile'
import { typecheckViews } from '@/lib/studio/builder/typecheck'
import { COMPILER_ID } from '@/lib/studio/builder/compile'
import type { AgentModel, ModelStepInput, ModelStepResult } from '@/lib/studio/builder/model'
import type { WorkerCheckLike } from '@/lib/studio/builder/checks'
import type { PluginPath } from '@/lib/studio/builder/paths'

export const FLASHCARDS_MANIFEST = {
  name: 'Term flashcards',
  description: 'Students flip through this week’s terms and mark the ones they already know.',
  views: { student: { capabilities: [] }, professor: { capabilities: [] } },
  collections: {
    cards: { access: 'shared', fields: { term: 'text', definition: 'text' } },
    progress: { access: 'perStudent', fields: { cardId: 'text', known: 'boolean' } },
  },
  purpose: { category: 'practice', summary: 'Students review key terms with flashcards and track which ones they already know.', audience: 'both' },
  signals: [],
  skillSlots: [],
  aiFallback: 'not-applicable',
}

export const STUDENT_VIEW = `import { useState } from 'react'
import { Screen, Stack, Card, Text, Button, Loading, Empty, ErrorState, useRequest, request, type PluginRecord } from '@scholera/plugin-kit'

type Flashcard = { term: string; definition: string }

export default function StudentView() {
  const cards = useRequest<PluginRecord<Flashcard>[]>('records.list', { collection: 'cards' })
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  if (cards.status === 'loading') return <Screen title="Flashcards"><Loading /></Screen>
  if (cards.status === 'error') return <Screen title="Flashcards"><ErrorState onRetry={cards.retry} /></Screen>
  const list = cards.data ?? []
  if (list.length === 0) return <Screen title="Flashcards"><Empty title="No cards yet" description="Your professor hasn't added any terms." /></Screen>
  const card = list[index % list.length]
  const markKnown = () => {
    void request('records.create', { collection: 'progress', data: { cardId: card.id, known: true } })
  }
  return (
    <Screen title="Flashcards">
      <Card><Text>{flipped ? card.data.definition : card.data.term}</Text></Card>
      <Stack direction="row" gap="small">
        <Button onPress={() => setFlipped((f) => !f)}>{flipped ? 'Show term' : 'Flip'}</Button>
        <Button variant="secondary" onPress={markKnown}>I know this</Button>
        <Button variant="secondary" onPress={() => { setFlipped(false); setIndex((i) => i + 1) }}>Next</Button>
      </Stack>
    </Screen>
  )
}
`

export const PROFESSOR_VIEW = `import { useState } from 'react'
import { Screen, Stack, Card, Text, Button, TextField, Loading, Empty, ErrorState, useRequest, request, type PluginRecord } from '@scholera/plugin-kit'

type Flashcard = { term: string; definition: string }

export default function ProfessorView() {
  const cards = useRequest<PluginRecord<Flashcard>[]>('records.list', { collection: 'cards' })
  const [term, setTerm] = useState('')
  const [definition, setDefinition] = useState('')
  const add = () => {
    void request('records.create', { collection: 'cards', data: { term, definition } }).then(cards.retry, cards.retry)
    setTerm('')
    setDefinition('')
  }
  const list = cards.data ?? []
  return (
    <Screen title="Flashcards">
      <Stack gap="small">
        <TextField label="Term" value={term} onChange={setTerm} />
        <TextField label="Definition" value={definition} onChange={setDefinition} multiline />
        <Button onPress={add} disabled={!term || !definition}>Add card</Button>
      </Stack>
      {cards.status === 'loading' ? <Loading /> : cards.status === 'error' ? <ErrorState onRetry={cards.retry} /> : list.length === 0 ? <Empty title="No cards yet" description="Add the first term above." /> : (
        <Stack gap="small">
          {list.map((c) => <Card key={c.id}><Text>{c.data.term}</Text><Text tone="muted">{c.data.definition}</Text></Card>)}
        </Stack>
      )}
    </Screen>
  )
}
`

/** The check worker's work, in process: the same compile and typecheck functions. */
export async function inProcessWorkerCheck(files: Record<PluginPath, string>): Promise<WorkerCheckLike> {
  return {
    compiler: COMPILER_ID,
    compile: { 'views/student.tsx': compileView('views/student.tsx', files['views/student.tsx']), 'views/professor.tsx': compileView('views/professor.tsx', files['views/professor.tsx']) },
    typecheck: typecheckViews(files),
  }
}

export type ScriptedTurn =
  | { calls: { name: string; input: unknown; invalid?: boolean }[] }
  | { timeout: true }
  | { truncated: true }
  | { unavailable: true }
  /** Waits until the harness aborts the call (Stop, a lost claim). */
  | { hang: true }
  | ((input: ModelStepInput) => { name: string; input: unknown }[])

/** A model that plays back a script, one entry per turn, and records every prompt. */
export function scriptedModel(script: ScriptedTurn[]): AgentModel & { prompts: ModelStepInput[] } {
  const prompts: ModelStepInput[] = []
  let i = 0
  const usage = { input: 1000, cachedInput: 0, output: 200, reasoning: 100 }
  return {
    id: 'gemini-3.1-pro-preview',
    prompts,
    async step(input): Promise<ModelStepResult> {
      prompts.push(input)
      const turn = script[i++]
      const base = { textLength: 0, timedOut: false, usage, latencyMs: 1, modelId: 'gemini-3.1-pro-preview' }
      if (!turn) return { ...base, toolCalls: [], finishReason: 'stop' }
      if (typeof turn === 'function') return { ...base, toolCalls: turn(input).map((c) => ({ ...c, invalid: false })), finishReason: 'tool-calls' }
      if ('timeout' in turn) return { ...base, toolCalls: [], finishReason: 'timeout', timedOut: true }
      if ('truncated' in turn) return { ...base, toolCalls: [{ name: 'finish', input: {}, invalid: false }], finishReason: 'length' }
      if ('unavailable' in turn) {
        const { ModelUnavailable } = await import('@/lib/studio/builder/model')
        throw new ModelUnavailable()
      }
      if ('hang' in turn) {
        const { BuilderAbort } = await import('@/lib/studio/builder/model')
        await new Promise<void>((resolve) => input.abortSignal.addEventListener('abort', () => resolve(), { once: true }))
        throw new BuilderAbort()
      }
      return { ...base, toolCalls: turn.calls.map((c) => ({ invalid: false, ...c })), finishReason: 'tool-calls' }
    },
  }
}

export const call = (name: string, input: unknown = {}) => ({ name, input })
export const plan = (files: PluginPath[] = ['views/student.tsx', 'views/professor.tsx']) =>
  call('submit_plan', {
    goal: 'Flashcards for this week’s terms.',
    files_to_change: files,
    manifest_changes: ['Add a cards collection'],
    capabilities_needed: [],
    checks: ['Both views show loading, empty and error states'],
    professor_view: ['Add and remove cards'],
    student_view: ['Flip through the cards'],
    data: ['cards (shared): the deck the professor writes'],
    requirements: ['Professor can add a card', 'Student can flip a card'],
    enhancements: [],
  })
export const proposeManifest = (manifest: unknown = FLASHCARDS_MANIFEST) => call('propose_manifest_change', { manifest_json: JSON.stringify(manifest) })
export const write = (path: PluginPath, content: string) => call('write_file', { path, content })
export const finish = (status: 'completed' | 'blocked' = 'completed', summary = 'Built flashcards.') => call('finish', { status, summary, open_questions: [] })
