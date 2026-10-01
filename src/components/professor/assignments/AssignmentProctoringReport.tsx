/**
 * Professor-facing proctoring report for an assessment submission. Advisory only —
 * flags never change the grade. Renders the aggregate stats, the suspicious-flag chips,
 * and any violation snapshots.
 *
 * Type: Client Component (thumbnails open the full image in a new tab)
 */
'use client'

import { ShieldCheck, ShieldAlert, Clipboard, MonitorX, Users, Smartphone, CameraOff, Minimize2 } from 'lucide-react'
import type { ProctoringSummary } from '@/lib/validations/proctoring'

export interface ProctoringSnapshotView {
  url: string | null
  violationType: string
  timestampOffset: number
  faceCount: number
}

const FLAG_LABELS: Record<string, string> = {
  multiple_paste_events: 'Multiple pastes',
  frequent_tab_switches: 'Frequent tab switches',
  excessive_copying: 'Excessive copying',
  multiple_faces_detected: 'Multiple faces seen',
  phone_detected: 'Phone detected',
  camera_denied: 'Camera not available',
  fullscreen_exit: 'Exited fullscreen',
}

/** Compact badge for the roster row / panel header. Suspicious when any flag fired. */
export function ProctoringBadge({ summary }: { summary: ProctoringSummary | null | undefined }) {
  if (!summary) return null
  const flagged = summary.suspiciousFlags.length > 0
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        flagged ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
      }`}
      title={flagged ? summary.suspiciousFlags.map((f) => FLAG_LABELS[f] ?? f).join(', ') : 'No proctoring flags'}
    >
      {flagged ? <ShieldAlert className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
      {flagged ? `${summary.suspiciousFlags.length} flag${summary.suspiciousFlags.length > 1 ? 's' : ''}` : 'Clean'}
    </span>
  )
}

const VIOLATION_LABELS: Record<string, string> = { mf: 'Multiple faces', ph: 'Phone', bl: 'Baseline' }

export function AssignmentProctoringReport({
  summary,
  snapshots,
}: {
  summary: ProctoringSummary | null
  snapshots: ProctoringSnapshotView[]
}) {
  if (!summary) return null

  const stats = [
    { icon: Clipboard, label: 'Copies', value: summary.copyCount },
    { icon: Clipboard, label: 'Pastes', value: summary.pasteCount },
    { icon: MonitorX, label: 'Tab switches', value: summary.tabSwitchCount },
    { icon: Users, label: 'Multiple faces', value: summary.multipleFaceCount },
    { icon: Smartphone, label: 'Phone', value: summary.phoneDetectedCount },
    { icon: Minimize2, label: 'Fullscreen exits', value: summary.fullscreenExitCount },
  ]

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proctoring report</p>
        <ProctoringBadge summary={summary} />
      </div>

      {summary.suspiciousFlags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {summary.suspiciousFlags.map((f) => (
            <span key={f} className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              {f === 'camera_denied' && <CameraOff className="h-3 w-3" />}
              {f === 'fullscreen_exit' && <Minimize2 className="h-3 w-3" />}
              {FLAG_LABELS[f] ?? f}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl bg-card p-2 text-center">
            <p className="text-lg font-semibold tabular-nums text-foreground">{s.value}</p>
            <p className="text-[11px] text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      {snapshots.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Snapshots ({snapshots.length})</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {snapshots.map((snap, i) =>
              snap.url ? (
                <a key={i} href={snap.url} target="_blank" rel="noopener noreferrer" className="group relative block overflow-hidden rounded-xl border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={snap.url} alt={`${VIOLATION_LABELS[snap.violationType] ?? snap.violationType} snapshot`} className="aspect-[4/3] w-full object-cover" />
                  <span className="absolute inset-x-0 bottom-0 bg-foreground/70 px-1 py-0.5 text-[10px] text-background">
                    {VIOLATION_LABELS[snap.violationType] ?? snap.violationType} · {Math.round(snap.timestampOffset / 1000)}s
                  </span>
                </a>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  )
}
