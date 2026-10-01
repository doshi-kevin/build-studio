// Slide-out sheet for viewing full feedback details and updating status/notes.
// Opens when an admin clicks a row in the feedback table.

'use client'

import { useState, useTransition } from 'react'
import {
  Loader2,
  Bug,
  Lightbulb,
  AlertCircle,
  Palette,
  HelpCircle,
  Globe,
  MapPin,
  Clock,
  Monitor,
  Layers,
  User,
  StickyNote,
} from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { updateFeedbackStatus } from '@/app/(dashboard)/feedback/actions'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { FeedbackStatus } from '@/lib/validations/feedback'

const RATING_CONFIG: Record<number, { emoji: string; label: string; color: string }> = {
  1: { emoji: '😞', label: 'Bad', color: 'bg-muted/30 border-border' },
  2: { emoji: '😐', label: 'Okay', color: 'bg-muted/30 border-border' },
  3: { emoji: '😊', label: 'Great', color: 'bg-muted/30 border-border' },
}

const CATEGORY_CONFIG: Record<string, { label: string; icon: typeof Bug; color: string }> = {
  bug: { label: 'Bug Report', icon: Bug, color: 'text-foreground border border-border bg-muted/50' },
  feature_request: { label: 'Feature Request', icon: Lightbulb, color: 'text-foreground border border-border bg-muted/50' },
  content_issue: { label: 'Content Issue', icon: AlertCircle, color: 'text-foreground border border-border bg-muted/50' },
  ux: { label: 'UX / Usability', icon: Palette, color: 'text-foreground border border-border bg-muted/50' },
  general: { label: 'General', icon: HelpCircle, color: 'text-foreground border border-border bg-muted/50' },
}

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive'; dot: string }> = {
  new: { label: 'New', variant: 'default', dot: 'bg-foreground/60' },
  reviewed: { label: 'Reviewed', variant: 'secondary', dot: 'bg-warning' },
  resolved: { label: 'Resolved', variant: 'outline', dot: 'bg-success' },
  dismissed: { label: 'Dismissed', variant: 'destructive', dot: 'bg-muted-foreground/40' },
}

interface FeedbackUser {
  id: string
  name: string | null
  email: string
  avatar_url: string | null
}

interface FeedbackItem {
  id: string
  user_id: string
  user_role: string
  rating: number
  category: string
  message: string | null
  page_url: string
  page_context: Record<string, unknown>
  status: string
  admin_notes: string | null
  created_at: string
  updated_at: string
  user: FeedbackUser
}

interface FeedbackDetailSheetProps {
  feedback: FeedbackItem | null
  onClose: () => void
}

function getInitials(name: string | null): string {
  if (!name) return '?'
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Parse browser user agent into a short readable string */
function parseBrowser(ua: string): string {
  if (!ua) return 'Unknown'
  if (ua.includes('Chrome') && !ua.includes('Edg')) {
    const match = ua.match(/Chrome\/([\d.]+)/)
    return `Chrome ${match?.[1]?.split('.')[0] || ''}`
  }
  if (ua.includes('Safari') && !ua.includes('Chrome')) {
    const match = ua.match(/Version\/([\d.]+)/)
    return `Safari ${match?.[1]?.split('.')[0] || ''}`
  }
  if (ua.includes('Firefox')) {
    const match = ua.match(/Firefox\/([\d.]+)/)
    return `Firefox ${match?.[1]?.split('.')[0] || ''}`
  }
  if (ua.includes('Edg')) {
    const match = ua.match(/Edg\/([\d.]+)/)
    return `Edge ${match?.[1]?.split('.')[0] || ''}`
  }
  return 'Other'
}

function parseOS(ua: string): string {
  if (!ua) return ''
  if (ua.includes('Mac OS')) return 'macOS'
  if (ua.includes('Windows')) return 'Windows'
  if (ua.includes('Linux')) return 'Linux'
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'
  if (ua.includes('Android')) return 'Android'
  return ''
}

export function FeedbackDetailSheet({ feedback, onClose }: FeedbackDetailSheetProps) {
  const [status, setStatus] = useState<FeedbackStatus | ''>(
    feedback?.status as FeedbackStatus || ''
  )
  const [adminNotes, setAdminNotes] = useState(feedback?.admin_notes || '')
  const [isPending, startTransition] = useTransition()

  const isOpen = !!feedback

  function handleOpenChange(open: boolean) {
    if (!open) {
      setStatus('')
      setAdminNotes('')
      onClose()
    }
  }

  function handleSave() {
    if (!feedback || !status) return

    startTransition(async () => {
      const result = await updateFeedbackStatus({
        id: feedback.id,
        status,
        admin_notes: adminNotes,
      })

      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Feedback updated.')
        handleOpenChange(false)
      }
    })
  }

  const ctx = feedback?.page_context as Record<string, string> | undefined
  const ratingInfo = feedback ? RATING_CONFIG[feedback.rating] : null
  const categoryInfo = feedback ? CATEGORY_CONFIG[feedback.category] : null
  const statusInfo = feedback ? STATUS_CONFIG[feedback.status] : null
  const CategoryIcon = categoryInfo?.icon || HelpCircle
  const browserStr = ctx?.browser ? `${parseBrowser(ctx.browser)}${parseOS(ctx.browser) ? ` / ${parseOS(ctx.browser)}` : ''}` : null

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto p-0">
        {feedback && (
          <>
            {/* Colored header band based on rating */}
            <div className={cn('px-6 pt-6 pb-4 border-b', ratingInfo?.color)}>
              <SheetHeader className="space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10 border-2 border-background shadow-sm">
                      <AvatarImage src={feedback.user?.avatar_url || undefined} />
                      <AvatarFallback className="text-xs font-semibold bg-background">
                        {getInitials(feedback.user?.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <SheetTitle className="text-base">{feedback.user?.name || 'Unknown User'}</SheetTitle>
                      <SheetDescription className="text-xs">
                        {feedback.user?.email}
                      </SheetDescription>
                    </div>
                  </div>
                  <Badge variant="outline" className="capitalize text-xs shrink-0 bg-background/80">
                    <User className="h-3 w-3 mr-1" />
                    {feedback.user_role}
                  </Badge>
                </div>

                {/* Rating + Category + Status row */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-2xl" title={ratingInfo?.label}>{ratingInfo?.emoji}</span>
                  <div className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', categoryInfo?.color)}>
                    <CategoryIcon className="h-3 w-3" />
                    {categoryInfo?.label || feedback.category}
                  </div>
                  <Badge variant={statusInfo?.variant || 'secondary'} className="gap-1.5">
                    <span className={cn('h-1.5 w-1.5 rounded-full', statusInfo?.dot)} />
                    {statusInfo?.label || feedback.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatRelativeTime(feedback.created_at)}
                  </span>
                </div>
              </SheetHeader>
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* Message section */}
              <section>
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Message
                </Label>
                {feedback.message ? (
                  <div className="mt-2 text-sm leading-relaxed whitespace-pre-wrap rounded-lg border bg-muted/30 p-4">
                    {feedback.message}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground italic">No message provided.</p>
                )}
              </section>

              <Separator />

              {/* Page context section */}
              <section>
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Context
                </Label>
                <div className="mt-2 grid gap-2">
                  <ContextRow icon={MapPin} label="Page" value={feedback.page_url} mono />
                  {ctx?.featureName && (
                    <ContextRow icon={Layers} label="Feature" value={ctx.featureName} capitalize />
                  )}
                  {ctx?.sectionId && (
                    <ContextRow icon={Globe} label="Section" value={ctx.sectionId} mono />
                  )}
                  {browserStr && (
                    <ContextRow icon={Monitor} label="Browser" value={browserStr} />
                  )}
                  <ContextRow
                    icon={Clock}
                    label="Submitted"
                    value={new Date(feedback.created_at).toLocaleString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  />
                </div>
              </section>

              <Separator />

              {/* Admin actions section */}
              <section>
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Admin Actions
                </Label>

                {/* Status selector */}
                <div className="mt-3 space-y-3">
                  <div>
                    <Label htmlFor="feedback-status" className="text-xs text-muted-foreground">
                      Update Status
                    </Label>
                    <Select value={status} onValueChange={(v) => setStatus(v as FeedbackStatus)}>
                      <SelectTrigger id="feedback-status" className="mt-1 h-9">
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                          <SelectItem key={key} value={key}>
                            <span className="flex items-center gap-2">
                              <span className={cn('h-2 w-2 rounded-full', cfg.dot)} />
                              {cfg.label}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Admin notes */}
                  <div>
                    <Label htmlFor="admin-notes" className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <StickyNote className="h-3 w-3" />
                      Internal Notes
                    </Label>
                    <Textarea
                      id="admin-notes"
                      value={adminNotes}
                      onChange={(e) => setAdminNotes(e.target.value)}
                      placeholder="Add internal notes about this feedback..."
                      className="mt-1 text-sm resize-none"
                      rows={3}
                      maxLength={2000}
                    />
                  </div>
                </div>
              </section>

              {/* Save button */}
              <Button
                onClick={handleSave}
                disabled={isPending || !status}
                className="w-full h-10"
                size="lg"
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Reusable row for the context section */
function ContextRow({
  icon: Icon,
  label,
  value,
  mono,
  capitalize: cap,
}: {
  icon: typeof MapPin
  label: string
  value: string
  mono?: boolean
  capitalize?: boolean
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 px-3 rounded-xl bg-muted/30 text-sm">
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground text-xs w-16 shrink-0">{label}</span>
      <span
        className={cn(
          'truncate',
          mono && 'font-mono text-xs',
          cap && 'capitalize',
        )}
      >
        {value}
      </span>
    </div>
  )
}
