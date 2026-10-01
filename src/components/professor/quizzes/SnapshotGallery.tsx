// Snapshot gallery for professor proctoring review.
// Shows a grid of violation snapshots with timestamps, violation types, and question numbers.
// Click a thumbnail to view the full-size image in a dialog.
'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Camera, Users, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ProctoringSnapshot } from '@/lib/validations/proctoring'

interface SnapshotGalleryProps {
  snapshots: ProctoringSnapshot[]
  attemptStartedAt: string
}

const VIOLATION_CONFIG: Record<string, { label: string; icon: typeof Camera; color: string }> = {
  mf: { label: 'Multiple Faces', icon: Users, color: 'bg-warning-muted text-warning-muted-foreground' },
  ph: { label: 'Phone Detected', icon: Smartphone, color: 'bg-destructive-muted text-destructive-muted-foreground' },
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export default function SnapshotGallery({ snapshots }: SnapshotGalleryProps) {
  const [selectedSnapshot, setSelectedSnapshot] = useState<ProctoringSnapshot | null>(null)

  if (snapshots.length === 0) return null

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Camera className="h-4 w-4" />
            Violation Snapshots ({snapshots.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {snapshots.map((snapshot) => {
              const config = VIOLATION_CONFIG[snapshot.violationType] ?? VIOLATION_CONFIG.mf
              const Icon = config.icon
              return (
                <button
                  key={snapshot.id}
                  onClick={() => setSelectedSnapshot(snapshot)}
                  className="group relative rounded-xl overflow-hidden border hover:border-ring/40 transition-colors cursor-pointer"
                >
                  <div className="aspect-4/3 relative bg-muted">
                    <Image
                      src={snapshot.snapshotUrl}
                      alt={`Violation: ${config.label}`}
                      fill
                      className="object-cover"
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                    />
                  </div>
                  <div className="p-1.5 space-y-1">
                    <Badge variant="secondary" className={`text-[10px] ${config.color}`}>
                      <Icon className="h-2.5 w-2.5 mr-1" />
                      {config.label}
                    </Badge>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>{formatOffset(snapshot.timestampOffset)}</span>
                      {snapshot.questionIndex != null && (
                        <span>Q{snapshot.questionIndex + 1}</span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Full-size dialog */}
      <Dialog open={!!selectedSnapshot} onOpenChange={() => setSelectedSnapshot(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedSnapshot && (() => {
                const config = VIOLATION_CONFIG[selectedSnapshot.violationType] ?? VIOLATION_CONFIG.mf
                const Icon = config.icon
                return (
                  <>
                    <Icon className="h-4 w-4" />
                    {config.label} at {formatOffset(selectedSnapshot.timestampOffset)}
                    {selectedSnapshot.questionIndex != null && (
                      <span className="text-muted-foreground font-normal">
                        — Question {selectedSnapshot.questionIndex + 1}
                      </span>
                    )}
                  </>
                )
              })()}
            </DialogTitle>
          </DialogHeader>
          {selectedSnapshot && (
            <div className="relative aspect-4/3 rounded-xl overflow-hidden bg-muted">
              <Image
                src={selectedSnapshot.snapshotUrl}
                alt="Violation snapshot"
                fill
                className="object-contain"
                sizes="500px"
              />
            </div>
          )}
          {selectedSnapshot && selectedSnapshot.faceCount > 0 && (
            <p className="text-sm text-muted-foreground">
              Faces detected: {selectedSnapshot.faceCount}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
