// Split "add question" button — Option D: one click adds the sticky
// (last-used) type; the arrow opens the type menu. Shared by the rail footer
// and the AddQuestionHub landing so the two menus can't drift apart.
// Ingestion (AI / bank / JSON) lives in the hub cards and the rail's
// "Add from AI, bank & JSON" button — not in this menu.

'use client'

import { Check, ChevronDown, Lock, Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import {
  QUESTION_TYPES,
  ADAPTIVE_ONLY_TYPES,
  QUESTION_TYPE_LABELS,
  type QuizItemType,
} from '@/lib/validations/quiz'

interface AddQuestionSplitButtonProps {
  /** The sticky one-click type (last used) */
  stickyType: QuizItemType
  /** Add a question of the given type (also makes it the new sticky type) */
  onAddType: (type: QuizItemType) => void
  /** Whether Adaptive Mode is on — unlocks the Explanation/Walkthrough types */
  adaptive: boolean
  /** 'sm' for the rail footer, 'default' for the hub landing */
  size?: 'sm' | 'default'
  menuAlign?: 'start' | 'center'
  className?: string
}

// Native buttons with inset focus rings so nothing pokes past the wrapper's
// rounded clip. App primary (blue) — the studio's main "add" action.
const SEGMENT =
  'flex items-center justify-center gap-1.5 bg-primary font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'

export function AddQuestionSplitButton({
  stickyType,
  onAddType,
  adaptive,
  size = 'default',
  menuAlign = 'start',
  className,
}: AddQuestionSplitButtonProps) {
  const sm = size === 'sm'
  return (
    <div className={cn('flex shrink-0 overflow-hidden rounded-xl shadow-sm', className)}>
      <button
        type="button"
        onClick={() => onAddType(stickyType)}
        aria-label={`Add ${QUESTION_TYPE_LABELS[stickyType]} question`}
        className={cn(SEGMENT, 'min-w-0 flex-1', sm ? 'h-8 px-2 text-xs' : 'h-9 px-4 text-sm')}
      >
        <Plus className={cn('shrink-0', sm ? 'h-3.5 w-3.5' : 'h-4 w-4')} aria-hidden="true" />
        <span className="truncate">{QUESTION_TYPE_LABELS[stickyType]}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Choose question type"
            className={cn(
              SEGMENT,
              'shrink-0 border-l border-background/20',
              sm ? 'h-8 w-8' : 'h-9 w-9',
            )}
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        {/* Wide enough that "Guided Walkthrough · Adaptive only" stays one line */}
        <DropdownMenuContent align={menuAlign} className="w-72">
          {QUESTION_TYPES.map((type) => (
            <DropdownMenuItem key={type} onClick={() => onAddType(type)}>
              {QUESTION_TYPE_LABELS[type]}
              {type === stickyType && (
                <span className="ml-auto flex items-center gap-1 text-xs font-medium text-primary">
                  default <Check className="h-3 w-3" aria-hidden="true" />
                </span>
              )}
            </DropdownMenuItem>
          ))}
          {/* Adaptive-only types — visible but plainly disabled outside Adaptive
              Mode (per the Option D mock); Adaptive is turned on in Settings */}
          {ADAPTIVE_ONLY_TYPES.map((type) =>
            adaptive ? (
              <DropdownMenuItem key={type} onClick={() => onAddType(type)}>
                {QUESTION_TYPE_LABELS[type]}
                {type === stickyType && (
                  <span className="ml-auto flex items-center gap-1 text-xs font-medium text-primary">
                  default <Check className="h-3 w-3" aria-hidden="true" />
                </span>
                )}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={type} disabled>
                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="text-muted-foreground">{QUESTION_TYPE_LABELS[type]}</span>
                <span className="ml-auto text-xs font-semibold text-chart-3">Adaptive only</span>
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
