import { describe, it, expect } from 'vitest'
import { renderGreeting, defaultVerbalAssessment, newVerbalCell, spokenPrompt, pickFollowUp, resolveVerbalAnswers, GREETING_PRESETS } from '@/lib/assignments/verbal/config'
import type { VerbalCell } from '@/lib/assignments/verbal/config'
import { verbalAssessmentSchema } from '@/lib/validations/verbal-assessment'
import { VERBAL_TEMPLATES } from '@/lib/assignments/verbal/verbal-templates'
import { sliceByOffsets } from '@/lib/ai/elevenlabs/stt'

describe('verbal assessment config (cell model)', () => {
  it('fills {name} and {topic} placeholders in the greeting', () => {
    expect(renderGreeting("Hey {name}, let's begin the assessment on {topic}.", { name: 'Alex', topic: 'Trees' }))
      .toBe("Hey Alex, let's begin the assessment on Trees.")
  })

  it('default config validates and starts with a greeting cell', () => {
    const d = defaultVerbalAssessment()
    expect(verbalAssessmentSchema.safeParse(d).success).toBe(true)
    expect(d.cells.length).toBeGreaterThan(0)
    expect(d.cells[0].type).toBe('greeting')
  })

  it('newVerbalCell shapes each cell type correctly', () => {
    expect(newVerbalCell('greeting').prompt).toContain('{name}')
    expect(newVerbalCell('question').answerType).toBe('short')
    expect(newVerbalCell('mcq').options).toHaveLength(2)
    expect(newVerbalCell('ai_followup').type).toBe('ai_followup')
  })

  it('cell ids are unique', () => {
    expect(newVerbalCell('question').id).not.toBe(newVerbalCell('question').id)
  })
})

describe('spokenPrompt (narration-safe text)', () => {
  it('passes plain text through unchanged', () => {
    expect(spokenPrompt('Explain how photosynthesis works.')).toBe('Explain how photosynthesis works.')
  })

  it('does not read inline math aloud, keeps the surrounding question', () => {
    const out = spokenPrompt('Given $E = mc^2$, explain what each term represents.')
    expect(out).not.toContain('mc^2')
    expect(out).not.toContain('$')
    expect(out.toLowerCase()).toContain('explain what each term represents')
    expect(out.toLowerCase()).toContain('formula')
  })

  it('replaces a formula-only prompt with a spoken cue', () => {
    const out = spokenPrompt('$$\\frac{d}{dx} e^x = e^x$$')
    expect(out).not.toContain('frac')
    expect(out.toLowerCase()).toContain('answer the following question')
  })

  it('handles code and images', () => {
    expect(spokenPrompt('Explain what `useEffect` does.').toLowerCase()).toContain('code snippet')
    expect(spokenPrompt('Describe ![chart](https://x/y.png) below.').toLowerCase()).toContain('image')
  })
})

describe('verbal templates', () => {
  it('exposes Depth, Breadth and Blank presets that all validate', () => {
    const ids = VERBAL_TEMPLATES.map((t) => t.id)
    expect(ids).toEqual(['deep-dive', 'broad-sweep', 'blank'])
    for (const t of VERBAL_TEMPLATES) {
      const cfg = t.build()
      expect(verbalAssessmentSchema.safeParse(cfg).success).toBe(true)
      expect(cfg.cells[0].type).toBe('greeting')
    }
  })

  it('Deep Dive starts with an MCQ after the greeting', () => {
    const cells = VERBAL_TEMPLATES.find((t) => t.id === 'deep-dive')!.build().cells
    expect(cells[1].type).toBe('mcq')
  })

  it('every greeting preset keeps the {name} and {topic} placeholders so it still personalizes', () => {
    expect(GREETING_PRESETS.length).toBeGreaterThan(0)
    for (const preset of GREETING_PRESETS) {
      expect(preset.text, `preset "${preset.label}" is missing {name}`).toContain('{name}')
      expect(preset.text, `preset "${preset.label}" is missing {topic}`).toContain('{topic}')
    }
  })
})

describe('sliceByOffsets (server transcript -> per-question)', () => {
  const words = [
    { text: 'photosynthesis', start: 5 },
    { text: 'converts', start: 6 },
    { text: 'light', start: 6.5 },
    { text: 'option', start: 20 },
    { text: 'B', start: 20.4 },
    { text: 'edge', start: 41 },
    { text: 'case', start: 41.5 },
  ]

  it('assigns each word to the question whose time window contains it', () => {
    expect(sliceByOffsets(words, [4, 18, 40])).toEqual([
      'photosynthesis converts light',
      'option B',
      'edge case',
    ])
  })

  it('the last window runs to the end of the recording', () => {
    expect(sliceByOffsets(words, [4, 40])).toEqual(['photosynthesis converts light option B', 'edge case'])
  })

  it('returns empty strings for windows with no speech', () => {
    expect(sliceByOffsets([], [0, 10])).toEqual(['', ''])
  })
})

describe('pickFollowUp (deterministic MCQ-branch follow-up selection)', () => {
  const mcq = (over: Partial<VerbalCell>): VerbalCell => ({
    id: 'm1', type: 'mcq', prompt: 'Pick one', correctOptionId: 'o1', ...over,
  })

  it('picks the correct branch when the student picked the answer key', () => {
    const cell = mcq({ followUps: { correct: 'Why is that right?', incorrect: 'Reconsider.' } })
    expect(pickFollowUp(cell, 'o1')).toEqual({ branch: 'correct', prompt: 'Why is that right?' })
  })

  it('picks the incorrect branch for any other (or no) selection', () => {
    const cell = mcq({ followUps: { correct: 'A', incorrect: 'What went wrong?' } })
    expect(pickFollowUp(cell, 'o2')).toEqual({ branch: 'incorrect', prompt: 'What went wrong?' })
    expect(pickFollowUp(cell, null)).toEqual({ branch: 'incorrect', prompt: 'What went wrong?' })
  })

  it('returns null when the matching branch is empty or whitespace-only', () => {
    expect(pickFollowUp(mcq({ followUps: { correct: '   ' } }), 'o1')).toBeNull()
    expect(pickFollowUp(mcq({ followUps: {} }), 'o1')).toBeNull()
  })

  it('returns null without an answer key (nothing to branch on)', () => {
    expect(pickFollowUp(mcq({ correctOptionId: undefined, followUps: { incorrect: 'x' } }), 'o2')).toBeNull()
  })

  it('returns null for non-MCQ cells', () => {
    const q: VerbalCell = { id: 'q1', type: 'question', prompt: 'Explain' }
    expect(pickFollowUp(q, 'o1')).toBeNull()
  })
})

describe('resolveVerbalAnswers (server-side prompt/type re-derivation, anti-forgery)', () => {
  const cells: VerbalCell[] = [
    { id: 'q1', type: 'question', prompt: 'Explain photosynthesis.' },
    {
      id: 'm1', type: 'mcq', prompt: 'Which gas is produced?', correctOptionId: 'o1',
      options: [{ id: 'o1', text: 'O2' }, { id: 'o2', text: 'CO2' }],
      followUps: { correct: 'Why oxygen?', incorrect: 'Reconsider the reactants.' },
    },
  ]

  it('replaces the client prompt/type with the server cell and passes other fields through', () => {
    const out = resolveVerbalAnswers(cells, [
      { cellId: 'q1', type: 'mcq' as const, prompt: '![x](http://evil/x.png)', transcript: 'kept' },
    ])
    expect(out[0].prompt).toBe('Explain photosynthesis.') // forged markdown discarded
    expect(out[0].type).toBe('question')
    expect(out[0].transcript).toBe('kept')
  })

  it('resolves an MCQ-branch follow-up from the base answer’s recorded pick', () => {
    const [, correct] = resolveVerbalAnswers(cells, [
      { cellId: 'm1', type: 'mcq' as const, prompt: '', selectedOptionId: 'o1' },
      { cellId: 'm1__fu', type: 'mcq' as const, prompt: 'forged' },
    ])
    expect(correct).toMatchObject({ prompt: 'Why oxygen?', type: 'question' })

    const [, incorrect] = resolveVerbalAnswers(cells, [
      { cellId: 'm1', type: 'mcq' as const, prompt: '', selectedOptionId: 'o2' },
      { cellId: 'm1__fu', type: 'mcq' as const, prompt: 'forged' },
    ])
    expect(incorrect.prompt).toBe('Reconsider the reactants.')
  })

  it('blanks the prompt for an unknown cellId (never trusts client text)', () => {
    const out = resolveVerbalAnswers(cells, [
      { cellId: 'ghost', type: 'question' as const, prompt: '<script>alert(1)</script>' },
    ])
    expect(out[0].prompt).toBe('')
  })
})
