/**
 * AnswerForm -- Inline answer form shown below a question in the Intel Q&A tab.
 *
 * Textarea with anonymous toggle and send button.
 * Only verified alumni can submit answers.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Send } from 'lucide-react'
import { submitAnswer } from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'

interface AnswerFormProps {
  questionId: string
  sectionId: string
  isAlumni: boolean
}

export function AnswerForm({ questionId, sectionId, isAlumni }: AnswerFormProps) {
  const [body, setBody] = useState('')
  const [isAnonymous, setIsAnonymous] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async () => {
    const trimmed = body.trim()
    if (!trimmed) {
      toast.error('Answer cannot be empty')
      return
    }

    setIsSubmitting(true)
    try {
      const result = await submitAnswer(questionId, sectionId, {
        body: trimmed,
        is_anonymous: isAnonymous,
      })

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Answer posted')
      setBody('')
      setIsAnonymous(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!isAlumni) {
    return (
      <div className="rounded-xl border border-dashed border-border p-3 text-center text-sm text-muted-foreground">
        Only verified alumni can answer questions
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write your answer..."
        className="resize-none"
        rows={3}
        disabled={isSubmitting}
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch
            checked={isAnonymous}
            onCheckedChange={setIsAnonymous}
            disabled={isSubmitting}
          />
          <Label className="text-xs text-muted-foreground cursor-pointer">
            Anonymous
          </Label>
        </div>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={isSubmitting || !body.trim()}
        >
          {isSubmitting ? (
            'Sending...'
          ) : (
            <>
              <Send className="h-3.5 w-3.5 mr-1.5" />
              Send
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
