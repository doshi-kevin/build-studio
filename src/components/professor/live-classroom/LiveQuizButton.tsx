// One-click AI quiz generation button for the live classroom. Generates
// 10 MCQs from the lecture transcription + slide content using Gemini
// Flash and pushes them live to students.

'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Plus, Bot } from 'lucide-react'
import { toast } from 'sonner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { generateAndPushLiveQuiz } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import { SPRING_SNAPPY } from '@/lib/motion'

interface LiveQuizButtonProps {
  roomId: string
  hasTranscription: boolean
  /** Time limit (seconds) the professor picked; passed to the generated quiz. */
  timeLimitSeconds: number
  /** Reveal correct answers to students immediately on submit (vs. on close). */
  revealAnswers: boolean
}

const COOLDOWN_MS = 30_000

export function LiveQuizButton({ roomId, hasTranscription, timeLimitSeconds, revealAnswers }: LiveQuizButtonProps) {
  const [isGenerating, setIsGenerating] = useState(false)
  const [cooldown, setCooldown] = useState(false)
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current)
    }
  }, [])

  const handleGenerate = useCallback(async () => {
    if (isGenerating || cooldown) return

    setIsGenerating(true)
    try {
      const result = await generateAndPushLiveQuiz({ roomId, timeLimitSeconds, revealAnswers })

      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('AI quiz pushed to students!', {
          description: '10 questions generated from your lecture content',
        })

        setCooldown(true)
        cooldownTimerRef.current = setTimeout(() => setCooldown(false), COOLDOWN_MS)
      }
    } catch {
      toast.error('Failed to generate quiz')
    } finally {
      setIsGenerating(false)
    }
  }, [roomId, isGenerating, cooldown, timeLimitSeconds, revealAnswers])

  const disabled = isGenerating || cooldown || !hasTranscription

  const hint = !hasTranscription
    ? 'Start transcribing first'
    : cooldown
      ? 'Try again shortly'
      : isGenerating
        ? 'Generating…'
        : '10 MCQs from your lecture so far'

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <motion.button
            type="button"
            onClick={handleGenerate}
            disabled={disabled}
            whileHover={disabled ? {} : { y: -2 }}
            whileTap={disabled ? {} : { scale: 0.98 }}
            transition={SPRING_SNAPPY}
            className={`group flex flex-col items-start gap-2 rounded-2xl border p-3.5 text-left h-full transition-colors ${
              disabled
                ? 'border-border bg-muted/20 opacity-60 cursor-not-allowed'
                : 'border-border bg-background hover:bg-muted/30 hover:border-foreground/30'
            }`}
          >
            <div className="flex items-center justify-between w-full">
              <div className={`rounded-xl border p-2 transition-colors ${
                disabled
                  ? 'bg-muted/40 border-border'
                  : 'bg-muted/40 border-border group-hover:bg-primary group-hover:text-primary-foreground group-hover:border-primary'
              }`}>
                {isGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Bot className="h-4 w-4" aria-hidden="true" />
                )}
              </div>
              {!disabled && <Plus className="h-3.5 w-3.5 text-muted-foreground/60 group-hover:text-foreground transition-colors" aria-hidden="true" />}
            </div>
            <div>
              <p className="text-sm font-medium leading-tight">
                {isGenerating ? 'Generating…' : 'Generate with AI'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
            </div>
          </motion.button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {!hasTranscription
            ? 'Enable transcription first — the AI needs lecture content'
            : 'Generate 10 MCQs from your lecture so far'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
