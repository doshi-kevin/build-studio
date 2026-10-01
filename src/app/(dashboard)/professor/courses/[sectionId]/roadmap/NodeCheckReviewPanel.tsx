'use client'

/**
 * NodeCheckReviewPanel — the professor's read-only view of one student's node
 * check (docs/designs/roadmap-mastery/roadmap-engine.md §14.2).
 *
 * Shows the five questions that student was dealt, what they picked, and the
 * result. There is deliberately no edit affordance: the check is a nudge the
 * student owns, and a professor "correcting" it would turn it into grading —
 * the one thing §14.2 says it must never become.
 */

import { useEffect, useState } from 'react'

export interface ReviewedQuestionView {
  prompt: string
  choices: string[]
  answerIndex: number
  selected: number | null
}

export interface NodeCheckReviewView {
  questions: ReviewedQuestionView[]
  passed: boolean
  tries: number
}

export interface NodeCheckReviewPanelProps {
  itemId: string
  studentId: string
  studentName?: string
  load: (
    itemId: string,
    studentId: string,
  ) => Promise<{ data?: NodeCheckReviewView | null; error?: string }>
}

export function NodeCheckReviewPanel({ itemId, studentId, studentName, load }: NodeCheckReviewPanelProps) {
  // Three distinct states, kept apart on purpose: a failed READ must never be
  // rendered as "they haven't started", which is a confident claim about the
  // student that a professor might act on.
  const [view, setView] = useState<NodeCheckReviewView | 'loading' | 'none' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await load(itemId, studentId)
      if (cancelled) return
      if (res.error) { setView('error'); return }
      setView(res.data ?? 'none')
    })()
    return () => { cancelled = true }
  }, [itemId, studentId, load])

  const who = studentName ?? 'This student'

  if (view === 'loading') {
    return (<><div className="dlabel">QUICK CHECK</div><div className="dfoot">loading…</div></>)
  }
  if (view === 'error') {
    return (
      <>
        <div className="dlabel">QUICK CHECK</div>
        <div className="dfoot">Couldn&apos;t load this — try reopening the card.</div>
      </>
    )
  }
  if (view === 'none') {
    return (
      <>
        <div className="dlabel">QUICK CHECK</div>
        <div className="dfoot">{who} hasn&apos;t started this one.</div>
      </>
    )
  }

  return (
    <>
      <div className="dlabel">QUICK CHECK</div>
      <div className={view.passed ? 'ncdone' : 'dfoot'}>
        {who} — {view.passed ? '✓ passed' : 'not passed yet'}
        {view.tries > 0 ? ` · ${view.tries} ${view.tries === 1 ? 'try' : 'tries'}` : ''}
      </div>
      {view.questions.map((q, i) => (
        <div key={i} className="ncq">
          <div className="ncqp">{i + 1}. {q.prompt}</div>
          {q.choices.map((c, ci) => {
            // Mark the STUDENT's answer, the way every LMS a professor already
            // uses does: ✓ they got it, ✗ they missed it. The key is called out
            // separately, and only when they missed — otherwise five identical
            // ✓ marks on the key would make "right" and "unanswered" look the
            // same, readable only as the absence of another row.
            const isKey = ci === q.answerIndex
            const isPick = ci === q.selected
            const missed = q.selected !== null && q.selected !== q.answerIndex
            if (isPick) {
              return (
                <div key={ci} className={`ncopt ro ${isKey ? 'right' : 'wrong'}`}>
                  {isKey ? '✓ ' : '✗ '}{c}
                </div>
              )
            }
            if (isKey && missed) {
              return <div key={ci} className="ncopt ro key">{c} — correct answer</div>
            }
            return <div key={ci} className="ncopt ro">{c}</div>
          })}
        </div>
      ))}
      <div className="dfoot">effort evidence, not a grade — nothing here counts toward marks.</div>
    </>
  )
}
