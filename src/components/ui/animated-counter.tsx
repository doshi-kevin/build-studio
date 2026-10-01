/**
 * AnimatedCounter -- animates a number from 0 to a target value with ease-out easing.
 *
 * Uses requestAnimationFrame for smooth 60fps animation. Supports optional
 * prefix (e.g., "$") and suffix (e.g., "%") around the number. Numbers are
 * formatted with toLocaleString() for thousands separators.
 *
 * Type: Client Component (uses useEffect + useRef for animation)
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface AnimatedCounterProps {
  value: number
  duration?: number
  prefix?: string
  suffix?: string
  className?: string
}

export function AnimatedCounter({
  value,
  duration = 1200,
  prefix = '',
  suffix = '',
  className,
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = useState(0)
  const animationRef = useRef<number | null>(null)
  const startTimeRef = useRef<number | null>(null)
  /* A number counting up is pure motion — there is no state change underneath
     it, the value was already correct on first paint. So for a reader who asked
     for less motion there is nothing to preserve: show the real number. */
  const reduce = useReducedMotion()

  useEffect(() => {
    if (reduce) return

    // Cancel any in-progress animation
    if (animationRef.current != null) {
      cancelAnimationFrame(animationRef.current)
    }

    startTimeRef.current = null

    const animate = (timestamp: number) => {
      if (startTimeRef.current == null) {
        startTimeRef.current = timestamp
      }

      const elapsed = timestamp - startTimeRef.current
      const progress = Math.min(elapsed / duration, 1)

      // Ease-out cubic: 1 - (1 - t)^3
      const easedProgress = 1 - Math.pow(1 - progress, 3)

      setDisplayValue(Math.round(easedProgress * value))

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate)
      } else {
        // Ensure we land exactly on the target value
        setDisplayValue(value)
      }
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current != null) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [value, duration, reduce])

  return (
    <span className={cn(className)}>
      {prefix}
      {(reduce ? value : displayValue).toLocaleString()}
      {suffix}
    </span>
  )
}
