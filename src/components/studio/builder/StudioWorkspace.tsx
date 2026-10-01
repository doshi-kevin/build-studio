'use client'

import { useState } from 'react'
import { ArrowUp, Blocks } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Textarea } from '@/components/ui/textarea'
import { StudioBuilder } from './StudioBuilder'
import type { ChatMessage, StudioBuild } from './types'

const id = () => crypto.randomUUID()

// Honest until an AI model is connected: nothing is simulated or templated.
const NOT_CONNECTED =
  'I can’t build yet. Studio’s building needs an AI model, and none is connected here. Your description is kept in this draft, so building can start from it once I’m connected.'

export function StudioWorkspace() {
  const [builds, setBuilds] = useState<StudioBuild[]>([])
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')

  const active = builds.find((b) => b.id === activeId) ?? null
  const say = (buildId: string, ...msgs: ChatMessage[]) =>
    setChats((c) => ({ ...c, [buildId]: [...(c[buildId] ?? []), ...msgs] }))

  const start = () => {
    const text = prompt.trim()
    if (!text) return
    const build: StudioBuild = { id: id(), title: 'Untitled feature', prompt: text }
    setBuilds((bs) => [build, ...bs])
    say(build.id, { id: id(), role: 'user', text }, { id: id(), role: 'athena', text: NOT_CONNECTED })
    setActiveId(build.id)
    setPrompt('')
  }

  const send = (text: string) => {
    if (!active) return
    say(active.id, { id: id(), role: 'user', text }, { id: id(), role: 'athena', text: NOT_CONNECTED })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-3xl">Studio</h1>
          <Badge variant="secondary">Preview</Badge>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          Describe any feature you want for this course, the way you teach it. Athena builds it with a view for you and a
          view for your students, you refine it together, and when it’s ready you publish it to your course sidebar.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          start()
        }}
        className="rounded-2xl bg-card p-4 shadow-sm"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            aria-label="Describe the feature you want"
            placeholder="Describe the feature you want to build for this course"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                start()
              }
            }}
            className="min-h-0 resize-none border-0 shadow-none focus-visible:ring-0"
          />
          <Button type="submit" className="h-10 shrink-0" disabled={!prompt.trim()}>
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
            Build
          </Button>
        </div>
      </form>

      <section aria-labelledby="drafts-heading" className="space-y-3">
        <h2 id="drafts-heading" className="text-base font-semibold">
          Your drafts
        </h2>
        {builds.length === 0 ? (
          <EmptyState
            variant="teaching"
            icon={Blocks}
            title="No drafts yet"
            description="Describe a feature above to start one. Drafts aren’t saved in this preview."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {builds.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(b.id)}
                  className="flex w-full flex-col items-start gap-1 rounded-2xl bg-card p-4 text-left shadow-sm transition-shadow hover:shadow-md"
                >
                  <span className="font-medium">{b.title}</span>
                  <span className="line-clamp-2 text-sm text-muted-foreground">{b.prompt}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <StudioBuilder
        build={active}
        messages={active ? (chats[active.id] ?? []) : []}
        busy={false}
        onClose={() => setActiveId(null)}
        onSend={send}
        onRename={(title) => active && setBuilds((bs) => bs.map((b) => (b.id === active.id ? { ...b, title } : b)))}
      />
    </div>
  )
}
