'use client'

import { ArrowBigUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface UpvoteButtonProps {
  count: number
  hasVoted: boolean
  onVote: () => void
  disabled?: boolean
}

export function UpvoteButton({
  count,
  hasVoted,
  onVote,
  disabled = false,
}: UpvoteButtonProps) {
  return (
    <Button
      variant={hasVoted ? 'default' : 'outline'}
      size="sm"
      onClick={onVote}
      disabled={disabled}
      className={cn(
        'gap-1 h-8 px-2.5 text-xs',
        hasVoted && 'bg-primary text-primary-foreground'
      )}
    >
      <ArrowBigUp
        className={cn(
          'h-4 w-4',
          hasVoted && 'fill-current'
        )}
      />
      <span>{count}</span>
    </Button>
  )
}
