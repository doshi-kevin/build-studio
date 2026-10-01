/**
 * BrandMark — the Scholera logo mark. One place to control the brand image so a
 * future logo swap is a single change. Size it via `className` (e.g. "h-8 w-8").
 */
import Image from 'next/image'
import { cn } from '@/lib/utils'

export function BrandMark({ className }: { className?: string }) {
  return (
    <Image
      src="/logo-mark.png"
      alt="Scholera"
      width={882}
      height={832}
      priority
      className={cn('object-contain', className)}
    />
  )
}
