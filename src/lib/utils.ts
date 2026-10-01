/**
 * Tailwind CSS class name merge utility (installed by shadcn/ui).
 *
 * Combines clsx (conditional class joining) with tailwind-merge (conflict resolution).
 * When two conflicting Tailwind classes are applied (e.g. "px-4" and "px-6"),
 * the last one wins instead of both being applied.
 *
 * Used throughout all components for dynamic class name composition.
 *
 * Example:
 *   cn('px-4 py-2', isActive && 'bg-blue-500', className)
 *   // If isActive is true:  'px-4 py-2 bg-blue-500 [className]'
 *   // If isActive is false: 'px-4 py-2 [className]'
 */

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
