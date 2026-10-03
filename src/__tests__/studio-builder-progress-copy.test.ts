import { describe, expect, it } from 'vitest'
import { workingCopy } from '@/components/studio/builder/RunCards'
import { endingCopy } from '@/lib/studio/builder/service'
import { STUDIO_BUILDER_QUEUE_NOTICE_MS } from '@/lib/studio/limits'

describe('the line beside the spinner', () => {
  it('follows the run’s phase once a worker has it', () => {
    expect(workingCopy('planning', null)).toBe('Planning the tool…')
    expect(workingCopy('checking', null)).toBe('Running checks…')
    expect(workingCopy('repairing', null)).toBe('Fixing what the checks found…')
    expect(workingCopy('reviewing', null)).toBe('Reviewing the design…')
    expect(workingCopy('improving', null)).toBe('Improving the interface…')
    expect(workingCopy(null, null)).toBe('Understanding your request…')
  })

  it('says so when no worker has picked the run up', () => {
    expect(workingCopy(null, 1000)).toBe('Starting…')
    expect(workingCopy(null, STUDIO_BUILDER_QUEUE_NOTICE_MS + 1)).toBe('Still waiting to start…')
  })

  it('never shows a step as running right after the line that says it finished', () => {
    expect(workingCopy('checking', null, 'Checks passed')).toBe('Finishing up…')
    expect(workingCopy('understanding', null, 'Understanding your request')).toBe('Working on the next step…')
    expect(workingCopy('repairing', null, 'Fixing what the checks found')).toBe('Working on the next step…')
    expect(workingCopy('checking', null, 'Building the student view')).toBe('Running checks…')
    expect(workingCopy('improving', null, 'Improving the interface')).toBe('Working on the next step…')
  })

  it('after the checks, says whether the design review or the save comes next', () => {
    expect(workingCopy('reviewing', null, 'Checks passed')).toBe('Reviewing the design…')
    expect(workingCopy('reviewing', null, 'Rendering the preview')).toBe('Reviewing the design…')
    expect(workingCopy('reviewing', null, 'Design review passed')).toBe('Finishing up…')
    expect(workingCopy('improving', null, 'Found improvements to make')).toBe('Improving the interface…')
  })
})

describe('a model that could not be reached', () => {
  it('tells the professor what happened and that nothing was saved', () => {
    const copy = endingCopy('failed', 'model_unavailable')
    expect(copy).toMatch(/couldn’t reach the AI service/)
    expect(copy).toMatch(/Your tool is unchanged/)
    expect(copy).toMatch(/without saving/)
  })
})

describe('a failed build says which kind of failure it was', () => {
  it('never falls back to one generic line for a known reason', () => {
    const lines = ['repeated_tool_errors', 'check_timeout', 'model_unavailable', 'interrupted', 'internal'].map((r) => endingCopy('failed', r))
    expect(new Set(lines).size).toBe(lines.length)
    expect(lines.join(' ')).not.toMatch(/Something went wrong on our side/)
    expect(endingCopy('cancelled', 'expired')).toMatch(/expired/)
  })
})
