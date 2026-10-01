// Start button for live classroom — handles room creation and navigation.

'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Play, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { createRoomDraft } from './actions'

interface LiveClassroomStartButtonProps {
  sectionId: string
}

export function LiveClassroomStartButton({ sectionId }: LiveClassroomStartButtonProps) {
  const router = useRouter()
  const [isStarting, setIsStarting] = useState(false)

  const handleStart = useCallback(async () => {
    if (isStarting) return

    setIsStarting(true)
    const result = await createRoomDraft({ sectionId })

    if (result.error) {
      toast.error(result.error)
      setIsStarting(false)
    } else if (result.roomId) {
      toast.success('Live class started')
      router.push(`/professor/courses/${sectionId}/live-classroom/${result.roomId}`)
    }
  }, [sectionId, router, isStarting])

  return (
    <Button onClick={handleStart} disabled={isStarting}>
      {isStarting ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          Starting…
        </>
      ) : (
        <>
          <Play className="h-4 w-4" />
          Start a live session
        </>
      )}
    </Button>
  )
}
