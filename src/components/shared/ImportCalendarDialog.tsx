'use client'

import { useState, useCallback, useRef } from 'react'
import { Upload, FileUp, Loader2, CalendarPlus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { parseICalString, type ParsedEvent } from '@/lib/calendar/ics-parser'
import { MAX_CALENDAR_IMPORT } from '@/lib/validations/calendar'
import { importCalendarEvents } from '@/app/(dashboard)/professor/calendar/actions'

interface ImportCalendarDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  professorId?: string
  /** Bulk-import function; defaults to the professor's blocked-times import. */
  importFn?: (
    events: { summary: string; description: string; location: string; dtstart: string; dtend: string }[],
  ) => Promise<{ error?: string; count: number }>
  /** Noun used in the copy + success toast (e.g. "blocked times", "personal events"). */
  noun?: string
}

export function ImportCalendarDialog({
  open,
  onOpenChange,
  importFn = importCalendarEvents,
  noun = 'blocked times',
}: ImportCalendarDialogProps) {
  const [parsedEvents, setParsedEvents] = useState<ParsedEvent[]>([])
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set())
  const [fileName, setFileName] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return

    const icsFiles = files.filter((f) => f.name.endsWith('.ics'))
    if (icsFiles.length === 0) {
      toast.error('Please select .ics calendar file(s)')
      return
    }
    if (icsFiles.length < files.length) {
      toast.error('Some files were skipped — only .ics files are supported')
    }

    const readFile = (file: File) =>
      new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = (ev) => resolve((ev.target?.result as string) ?? '')
        reader.onerror = () => resolve('')
        reader.readAsText(file)
      })

    // Read every file, merge their events, and de-dupe across files (by UID, falling
    // back to summary+start when a UID is missing). Keep only recent/future events.
    void Promise.all(icsFiles.map(readFile)).then((contents) => {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - 7)

      const byKey = new Map<string, ParsedEvent>()
      for (const content of contents) {
        for (const ev of parseICalString(content)) {
          if (!ev.dtstart || ev.dtstart < cutoff) continue
          const key = ev.uid || `${ev.summary}|${ev.dtstart.toISOString()}`
          if (!byKey.has(key)) byKey.set(key, { ...ev, uid: key })
        }
      }

      const relevant = Array.from(byKey.values())
      setParsedEvents(relevant)
      setSelectedUids(new Set(relevant.map((ev) => ev.uid)))
      setFileName(icsFiles.length === 1 ? icsFiles[0].name : `${icsFiles.length} files`)
    })
  }, [])

  const toggleEvent = useCallback((uid: string) => {
    setSelectedUids((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) {
        next.delete(uid)
      } else {
        next.add(uid)
      }
      return next
    })
  }, [])

  /* The dialog used to know nothing about the server's limit, so it rendered a clickable
     "Import 501 Events" and let the professor find out afterwards (#713 part 7). Deselecting
     is the user's call, not ours: silently importing the first 500 of someone's 800 events
     would look like success while quietly dropping 300 appointments. */
  const overBy = Math.max(0, selectedUids.size - MAX_CALENDAR_IMPORT)

  const toggleAll = useCallback(() => {
    if (selectedUids.size === parsedEvents.length) {
      setSelectedUids(new Set())
    } else {
      setSelectedUids(new Set(parsedEvents.map((e) => e.uid)))
    }
  }, [selectedUids.size, parsedEvents])

  const handleImport = useCallback(async () => {
    const selected = parsedEvents.filter((e) => selectedUids.has(e.uid))
    if (selected.length === 0) {
      toast.error('No events selected')
      return
    }
    if (selected.length > MAX_CALENDAR_IMPORT) {
      // Belt and braces: the button is disabled above the cap, but a stale render or a
      // keyboard activation should not reach a request the server will refuse anyway.
      toast.error(`Import at most ${MAX_CALENDAR_IMPORT} events at a time`)
      return
    }

    setIsImporting(true)
    try {
      const eventsToImport = selected.map((e) => ({
        summary: e.summary,
        description: e.description,
        location: e.location,
        dtstart: e.dtstart!.toISOString(),
        dtend: e.dtend?.toISOString() ?? e.dtstart!.toISOString(),
      }))

      const result = await importFn(eventsToImport)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success(`${result.count} event${result.count === 1 ? '' : 's'} imported as ${noun}`)
        onOpenChange(false)
        // Reset state
        setParsedEvents([])
        setSelectedUids(new Set())
        setFileName(null)
      }
    } catch {
      toast.error('Failed to import events')
    } finally {
      setIsImporting(false)
    }
  }, [parsedEvents, selectedUids, onOpenChange, importFn, noun])

  const handleClose = useCallback(() => {
    onOpenChange(false)
    setParsedEvents([])
    setSelectedUids(new Set())
    setFileName(null)
  }, [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5" />
            Import from Outlook
          </DialogTitle>
          <DialogDescription>
            Upload one or more .ics files exported from Outlook, Google, or Apple Calendar. Events will be imported as {noun} on your Scholera calendar.
          </DialogDescription>
        </DialogHeader>

        {parsedEvents.length === 0 ? (
          <div className="py-8">
            <input
              ref={inputRef}
              type="file"
              accept=".ics"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <div
              className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => inputRef.current?.click()}
            >
              <FileUp className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
              <p className="text-sm font-medium">Click to select .ics file(s)</p>
              <p className="text-xs text-muted-foreground mt-1">
                Export one or more calendars from Outlook as .ics files, then upload them here
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 space-y-3">
            {/* File info */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <Upload className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium truncate">{fileName}</span>
                <Badge variant="secondary">{parsedEvents.length} events</Badge>
              </div>
              <Button variant="ghost" size="sm" onClick={() => {
                setParsedEvents([])
                setSelectedUids(new Set())
                setFileName(null)
              }}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Select all */}
            <div className="flex items-center gap-2 border-b pb-2">
              <Checkbox
                checked={selectedUids.size === parsedEvents.length}
                onCheckedChange={toggleAll}
              />
              <span className="text-xs text-muted-foreground">
                {selectedUids.size} of {parsedEvents.length} selected
              </span>
              {overBy > 0 && (
                <span className="ml-auto text-xs font-medium text-destructive">
                  {MAX_CALENDAR_IMPORT} at a time — deselect {overBy}
                </span>
              )}
            </div>

            {/* Events list */}
            <div className="overflow-y-auto max-h-[40vh] space-y-1">
              {parsedEvents.map((event) => (
                <div
                  key={event.uid}
                  className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                  onClick={() => toggleEvent(event.uid)}
                >
                  <Checkbox
                    checked={selectedUids.has(event.uid)}
                    onCheckedChange={() => toggleEvent(event.uid)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{event.summary || 'Untitled Event'}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {event.dtstart && (
                        <span>
                          {event.dtstart.toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                          })}
                          {' '}
                          {event.dtstart.toLocaleTimeString('en-US', {
                            hour: 'numeric', minute: '2-digit',
                          })}
                        </span>
                      )}
                      {event.location && (
                        <span className="truncate">- {event.location}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {parsedEvents.length > 0 && (
          <DialogFooter>
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={handleImport}
              disabled={selectedUids.size === 0 || overBy > 0 || isImporting}
            >
              {isImporting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CalendarPlus className="h-4 w-4 mr-2" />
              )}
              Import {selectedUids.size} Event{selectedUids.size === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
