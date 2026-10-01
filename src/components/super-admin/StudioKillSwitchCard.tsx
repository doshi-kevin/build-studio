'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CircleAlert, PauseCircle, PlayCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { setStudioKillSwitch } from '@/app/(dashboard)/super-admin/ai-controls/studio-actions'

interface StudioKillSwitchCardProps {
  /** `unknown`: the switch couldn't be read, and Studio is treated as paused. */
  state: 'running' | 'engaged' | 'unknown'
}

const STATE = {
  running: { icon: PlayCircle, text: 'Studio is running.' },
  engaged: { icon: PauseCircle, text: 'Studio is paused everywhere. No tool runs for any institution.' },
  unknown: { icon: CircleAlert, text: 'The switch couldn’t be read, so Studio is treated as paused. Reload to try again.' },
} as const

/** The global Studio kill switch. The action and the database both check the role. */
export function StudioKillSwitchCard({ state }: StudioKillSwitchCardProps) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()
  // From unknown, the safe move is to pause; turning Studio on needs a known state.
  const next = state === 'running' || state === 'unknown'
  const Icon = STATE[state].icon

  const apply = () =>
    startTransition(async () => {
      const result = await setStudioKillSwitch(next)
      setConfirming(false)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(next ? 'Studio is paused everywhere' : 'Studio is running again')
      router.refresh()
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Studio</CardTitle>
        <CardDescription>
          Pausing stops every Studio tool for every institution: open tools close, nothing new loads, nothing is saved.
          Saved data is kept. Professors can still hide or remove tools.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          {STATE[state].text}
        </p>
        <Button
          type="button"
          variant={next ? 'destructive' : 'default'}
          className="min-h-11"
          onClick={() => setConfirming(true)}
          disabled={pending}
        >
          {next ? 'Pause Studio everywhere' : 'Turn Studio back on'}
        </Button>
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{next ? 'Pause Studio for every institution?' : 'Turn Studio back on?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {next
                ? 'Every open tool closes within a minute and nothing can be saved until you turn it back on.'
                : 'Tools load and save again wherever schools have Studio.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11" disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11"
              variant={next ? 'destructive' : 'default'}
              disabled={pending}
              onClick={(e) => {
                e.preventDefault()
                apply()
              }}
            >
              {pending ? 'Working…' : next ? 'Pause Studio' : 'Turn on'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
