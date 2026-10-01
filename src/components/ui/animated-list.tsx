/**
 * AnimatedList — subtle staggered entrance for list/grid content.
 *
 * Centralizes the dashboard's list motion so timing/easing is tuned in ONE
 * place across every tab (avoids per-file framer configs). Honors
 * prefers-reduced-motion by rendering content in its final state with no
 * transition. Motion conveys state (content arrived), not decoration.
 *
 * Usage:
 *   <AnimatedList className="grid gap-3">
 *     {items.map((it) => <AnimatedItem key={it.id}>...</AnimatedItem>)}
 *   </AnimatedList>
 */
'use client'

import { motion, useReducedMotion } from 'framer-motion'
import { ENTER } from '@/lib/motion'

const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: ENTER },
}

export function AnimatedList({
  children,
  className,
  stagger = 0.04,
}: {
  children: React.ReactNode
  className?: string
  stagger?: number
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      className={className}
      initial={reduce ? false : 'hidden'}
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: stagger } } }}
    >
      {children}
    </motion.div>
  )
}

export function AnimatedItem({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <motion.div className={className} variants={itemVariants}>
      {children}
    </motion.div>
  )
}
