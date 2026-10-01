/**
 * CalendarFeedCard — subscribe to Scholera calendar via iCal feed URL.
 *
 * Generates a token-based feed URL that Outlook can subscribe to.
 * Shows copy URL, add to Outlook, regenerate, and revoke actions.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition, useCallback, useEffect } from 'react'
import { Calendar, Copy, Check, RefreshCw, Loader2, ExternalLink, Shield, Download, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  getOrCreateCalendarToken,
  regenerateCalendarToken,
  revokeCalendarToken,
} from '@/app/(dashboard)/dashboard/calendar-token-actions'
import { ImportCalendarDialog } from './ImportCalendarDialog'

interface CalendarFeedCardProps {
  initialToken?: {
    id: string
    token: string
    last_accessed_at: string | null
    access_count: number
    created_at: string
  } | null
  /** Pass professorId to enable .ics import (professor only) */
  professorId?: string
  /** Render just the inner content (no Card chrome / title) — for use inside a dialog. */
  bare?: boolean
}

export function CalendarFeedCard({ initialToken, professorId, bare = false }: CalendarFeedCardProps) {
  const [token, setToken] = useState(initialToken || null)
  const [isPending, startTransition] = useTransition()
  const [copied, setCopied] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // window.location is unavailable during SSR. Gating the origin/host behind a
  // post-mount flag (false on the server AND the first client render) keeps both
  // renders identical, then fills in the absolute URL after hydration — avoiding
  // a hydration mismatch on the feed URL text and the localhost-conditional UI.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const feedUrl = token
    ? `${mounted ? window.location.origin : ''}/api/feeds/${token.token}.ics`
    : null

  const webcalUrl = token
    ? `webcal://${mounted ? window.location.host : ''}/api/feeds/${token.token}.ics`
    : null

  const handleGenerate = useCallback(() => {
    startTransition(async () => {
      const result = await getOrCreateCalendarToken()
      if (result.error) {
        toast.error(result.error)
        return
      }
      if (result.data) {
        setToken(result.data)
        toast.success('Calendar link generated')
      }
    })
  }, [])

  const handleCopy = useCallback(async () => {
    if (!feedUrl) return
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      toast.success('URL copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }, [feedUrl])

  const handleRegenerate = useCallback(() => {
    startTransition(async () => {
      const result = await regenerateCalendarToken()
      if (result.error) {
        toast.error(result.error)
        return
      }
      if (result.data) {
        setToken(result.data)
        toast.success('Calendar link regenerated. Old link will no longer work.')
      }
    })
  }, [])

  const handleRevoke = useCallback(() => {
    startTransition(async () => {
      const result = await revokeCalendarToken()
      if (result.error) {
        toast.error(result.error)
        return
      }
      setToken(null)
      toast.success('Calendar link revoked')
    })
  }, [])

  const handleDownload = useCallback(async () => {
    if (!feedUrl) return
    try {
      const res = await fetch(feedUrl)
      if (!res.ok) throw new Error('Failed to fetch calendar')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'scholera-calendar.ics'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('Calendar downloaded — open it in Outlook to import')
    } catch {
      toast.error('Failed to download calendar file')
    }
  }, [feedUrl])

  const isLocalhost = mounted &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

  const content = (
    <>
        <p className="text-xs text-muted-foreground">
          Add your Scholera events to Outlook or any calendar app. Events sync automatically —
          office hours, bookings, class sessions, and deadlines will appear in your calendar with reminders.
        </p>

        {/* Import from Outlook (.ics upload) — professor only */}
        {professorId && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setImportOpen(true)}
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Import from Outlook (.ics)
            </Button>
            <ImportCalendarDialog
              open={importOpen}
              onOpenChange={setImportOpen}
              professorId={professorId}
            />
          </>
        )}

        {!token ? (
          <Button onClick={handleGenerate} disabled={isPending} className="w-full">
            {isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Calendar className="h-4 w-4 mr-2" />
            )}
            Generate Calendar Link
          </Button>
        ) : (
          <div className="space-y-3">
            {/* Feed URL display */}
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 bg-muted rounded-xl px-3 py-2 text-xs font-mono break-all">
                {feedUrl}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="shrink-0"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>

            {/* How to subscribe — Outlook/Google subscribe by fetching the https link
                above server-side; the webcal button below is for Apple Calendar only. */}
            <div className="rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
              <p>
                <span className="font-medium text-foreground">Outlook:</span> Add calendar → Subscribe
                from web → paste the link above.
              </p>
              <p>
                <span className="font-medium text-foreground">Google Calendar:</span> Other calendars →
                From URL → paste the link.
              </p>
              <p>
                <span className="font-medium text-foreground">Apple Calendar:</span> use the button below.
              </p>
            </div>

            {/* Localhost hint */}
            {isLocalhost && (
              <p className="text-xs text-warning-muted-foreground bg-warning-muted rounded-xl px-3 py-2">
                Running on localhost — the online &ldquo;Subscribe from web&rdquo; options won&rsquo;t work
                locally (Outlook and Google fetch the link over the internet). Use &ldquo;Download .ics&rdquo;
                to import events manually.
              </p>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="default"
                size="sm"
                onClick={handleDownload}
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Download .ics
              </Button>

              {!isLocalhost && (
                <Button
                  variant="outline"
                  size="sm"
                  asChild
                >
                  <a href={webcalUrl || '#'}>
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Add to Apple Calendar
                  </a>
                </Button>
              )}

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={isPending}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                    Regenerate
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Regenerate Calendar Link?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will create a new calendar link. Your old link will stop working,
                      and you{"'"}ll need to re-subscribe in Outlook with the new URL.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleRegenerate}>
                      Regenerate
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={isPending}>
                    <Shield className="h-3.5 w-3.5 mr-1.5" />
                    Revoke
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revoke Calendar Link?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will deactivate your calendar link. Your calendar app will
                      no longer be able to sync events from Scholera.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleRevoke} variant="destructive">
                      Revoke
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>

            {/* Stats */}
            {(token.last_accessed_at || token.access_count > 0) && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
                {token.last_accessed_at && (
                  <span>
                    Last synced: {new Date(token.last_accessed_at).toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                    })}
                  </span>
                )}
                {token.access_count > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    {token.access_count} syncs
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}
    </>
  )

  if (bare) return <div className="space-y-4">{content}</div>

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          Subscribe to Calendar
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{content}</CardContent>
    </Card>
  )
}
