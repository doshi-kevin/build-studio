// Floating feedback widget that appears on every dashboard page.
// Captures emoji rating, category, optional message, and auto-collects page context.

'use client'

import { useState, useTransition } from 'react'
import { usePathname } from 'next/navigation'
import { X, Send, Loader2, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { submitFeedback } from '@/app/(dashboard)/feedback/actions'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { FeedbackCategory, PageContext } from '@/lib/validations/feedback'

const EMOJI_RATINGS = [
  { value: 1 as const, emoji: '😞', label: 'Bad' },
  { value: 2 as const, emoji: '😐', label: 'Okay' },
  { value: 3 as const, emoji: '😊', label: 'Great' },
]

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature_request', label: 'Feature Request' },
  { value: 'content_issue', label: 'Content Issue' },
  { value: 'ux', label: 'UX / Usability' },
  { value: 'general', label: 'General' },
]

interface FeedbackWidgetProps {
  userRole: string
}

/** Extract feature name from URL path (e.g., /student/courses/abc/quizzes → quizzes) */
function extractFeatureName(path: string): string | null {
  const courseMatch = path.match(/\/courses\/[^/]+\/([^/]+)/)
  return courseMatch ? courseMatch[1] : null
}

/** Extract section ID from URL path */
function extractSectionId(path: string): string | null {
  const match = path.match(/\/courses\/([^/]+)/)
  return match ? match[1] : null
}

/** Build page context from current browser state */
function buildPageContext(path: string, role: string): PageContext {
  return {
    pagePath: path,
    pageTitle: typeof document !== 'undefined' ? document.title : '',
    role,
    sectionId: extractSectionId(path),
    featureName: extractFeatureName(path),
    browser: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    timestamp: new Date().toISOString(),
  }
}

export function FeedbackWidget({ userRole }: FeedbackWidgetProps) {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const [rating, setRating] = useState<1 | 2 | 3 | null>(null)
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [message, setMessage] = useState('')
  const [isPending, startTransition] = useTransition()
  const [showSuccess, setShowSuccess] = useState(false)

  // Don't show for admins — they have the admin feedback page
  if (userRole === 'institution_admin') return null

  function resetForm() {
    setRating(null)
    setCategory('')
    setMessage('')
  }

  function handleClose() {
    setIsOpen(false)
    setShowSuccess(false)
    resetForm()
  }

  function handleSubmit() {
    if (!rating || !category) {
      toast.error('Please select a rating and category.')
      return
    }

    const pageContext = buildPageContext(pathname, userRole)

    startTransition(async () => {
      const result = await submitFeedback({
        rating,
        category,
        message: message || '',
        page_url: pathname,
        page_context: pageContext,
      })

      if (result.error) {
        toast.error(result.error)
      } else {
        setShowSuccess(true)
        resetForm()
        setTimeout(() => {
          handleClose()
        }, 1500)
      }
    })
  }

  return (
    <>
      {/* Floating trigger button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          data-feedback-widget
          // Bottom-LEFT: the bottom-right corner belongs to Athena's entry pill
          // and her docked composer, and the two were overlapping.
          className="fixed bottom-0 left-5 z-50 flex items-center gap-2 rounded-t-2xl bg-primary text-primary-foreground px-4 py-1.5 shadow-lg hover:opacity-90 transition-opacity duration-200 text-[13px] font-semibold"
          aria-label="Send feedback"
        >
          <MessageSquare className="h-4 w-4" />
          Feedback
        </button>
      )}

      {/* Feedback panel */}
      {isOpen && (
        <div data-feedback-widget className="fixed bottom-5 left-5 z-50 w-80 rounded-2xl border border-border bg-background shadow-2xl animate-in slide-in-from-bottom-4 fade-in duration-200">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="text-sm font-semibold">Share Feedback</h3>
            <button
              onClick={handleClose}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close feedback"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {showSuccess ? (
            <div className="px-4 py-8 text-center">
              <div className="text-3xl mb-2">🎉</div>
              <p className="text-sm font-medium">Thank you for your feedback!</p>
              <p className="text-xs text-muted-foreground mt-1">We&apos;ll use it to improve Scholera.</p>
            </div>
          ) : (
            <div className="px-4 py-3 space-y-3">
              {/* Emoji rating */}
              <div>
                <Label className="text-xs font-medium text-muted-foreground">
                  How&apos;s your experience?
                </Label>
                <div className="flex gap-2 mt-1.5">
                  {EMOJI_RATINGS.map((item) => (
                    <button
                      key={item.value}
                      onClick={() => setRating(item.value)}
                      className={cn(
                        'flex-1 flex flex-col items-center gap-0.5 py-2 rounded-lg border transition-[background-color,border-color,box-shadow] text-center',
                        rating === item.value
                          ? 'border-foreground bg-muted ring-1 ring-foreground'
                          : 'border-border hover:border-foreground/30 hover:bg-muted/50'
                      )}
                      aria-label={item.label}
                    >
                      <span className="text-xl">{item.emoji}</span>
                      <span className="text-[10px] text-muted-foreground">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Category */}
              <div>
                <Label htmlFor="feedback-category" className="text-xs font-medium text-muted-foreground">
                  What&apos;s this about?
                </Label>
                <Select value={category} onValueChange={(v) => setCategory(v as FeedbackCategory)}>
                  <SelectTrigger id="feedback-category" className="mt-1.5 h-9 text-sm">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  {/* Open upward — the widget sits at the bottom-right of the
                      viewport, so opening down would cover the textarea and
                      submit button. */}
                  <SelectContent side="top">
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Optional message */}
              <div>
                <Label htmlFor="feedback-message" className="text-xs font-medium text-muted-foreground">
                  Tell us more <span className="text-muted-foreground/60">(optional)</span>
                </Label>
                <Textarea
                  id="feedback-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="What could be better?"
                  className="mt-1.5 text-sm resize-none"
                  rows={3}
                  maxLength={5000}
                />
              </div>

              {/* Page context indicator — long URLs (with UUIDs) must truncate
                  so they don't blow out the fixed-width panel horizontally. */}
              <p className="text-[10px] text-muted-foreground/60 truncate" title={pathname}>
                📍 {pathname}
              </p>

              {/* Submit */}
              <Button
                onClick={handleSubmit}
                disabled={isPending || !rating || !category}
                className="w-full h-9 text-sm"
              >
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                ) : (
                  <Send className="h-3.5 w-3.5 mr-1.5" />
                )}
                {isPending ? 'Sending...' : 'Send Feedback'}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
