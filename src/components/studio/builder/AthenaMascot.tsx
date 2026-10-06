import Image from 'next/image'
import { cn } from '@/lib/utils'

/**
 * Bloub, the company mascot, as Athena's face in Studio (docs/reference/design-system.md 8.2).
 * Decorative: the text beside it always names Athena. One per screen. The file animates
 * itself and stops under reduced motion. `unoptimized` serves the SVG as is.
 */
export function AthenaMascot({ size, className }: { size: number; className?: string }) {
  return <Image src="/images/mascot-happy.svg" alt="" aria-hidden="true" width={size} height={size} unoptimized className={cn('shrink-0 select-none', className)} />
}
