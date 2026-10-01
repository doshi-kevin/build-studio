'use client'

import { useState } from 'react'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RatingStarsProps {
  value: number
  onChange?: (value: number) => void
  readonly?: boolean
  size?: 'sm' | 'md' | 'lg'
}

const sizeClasses = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
}

export function RatingStars({
  value,
  onChange,
  readonly = false,
  size = 'md',
}: RatingStarsProps) {
  const [hoverValue, setHoverValue] = useState(0)

  const displayValue = hoverValue || value

  return (
    <div className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= displayValue

        return (
          <button
            key={star}
            type="button"
            disabled={readonly}
            className={cn(
              'focus:outline-none',
              !readonly && 'cursor-pointer'
            )}
            onClick={() => !readonly && onChange?.(star)}
            onMouseEnter={() => !readonly && setHoverValue(star)}
            onMouseLeave={() => !readonly && setHoverValue(0)}
          >
            <Star
              className={cn(
                sizeClasses[size],
                'transition-colors duration-150 ease-out',
                filled
                  ? 'fill-warning text-warning'
                  : 'text-muted-foreground/30'
              )}
            />
          </button>
        )
      })}
    </div>
  )
}
