// Quiz-wide settings drawer — Option D of the studio design: all Quiz Info
// sections (description, timing, behavior, feedback, resources, scoring,
// adaptive, proctoring) in a right-hand sheet, one click from the studio
// header. The title is NOT here — it's edited inline in the studio header.

'use client'

import type { UseFormReturn } from 'react-hook-form'
import { Trash2 } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAthenaDock } from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import { QuizInfoStep } from './QuizInfoStep'
import type { WizardFormValues } from './QuizStudio'

interface QuizSettingsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  form: UseFormReturn<WizardFormValues>
  sectionId: string
  quizId?: string
  /** Roadmap placement — the module the quiz belongs to. null = still loading. */
  placementModules?: { id: string; title: string; weekNumber: number | null }[] | null
  placementModuleId?: string
  onPlacementChange?: (moduleId: string) => void
  /** Delete the whole quiz — shown as a destructive action at the end of the
   *  drawer. Omitted (button hidden) until the draft has actually been saved. */
  onDeleteQuiz?: () => void
}

export function QuizSettingsDrawer({
  open,
  onOpenChange,
  form,
  sectionId,
  quizId,
  placementModules,
  placementModuleId,
  onPlacementChange,
  onDeleteQuiz,
}: QuizSettingsDrawerProps) {
  // Athena docks on the same edge this drawer slides out of, at a higher z-index — so
  // without this the panel covers half the settings. Sit the drawer beside the dock
  // instead of under it, and keep it open when the professor clicks into Athena: asking
  // her to change a setting while watching it change is the whole point. Mirrors what
  // CreateAssignmentWizard does for its dialog.
  const { open: dockOpen } = useAthenaDock()
  const keepOpenOverAthena = (e: { target: EventTarget | null; preventDefault: () => void }) => {
    if ((e.target as HTMLElement | null)?.closest?.('[data-athena-dock]')) e.preventDefault()
  }

  return (
    // modal={false} is load-bearing, not a preference. A modal Radix dialog calls
    // hideOthers() (aria-hidden on the dock), sets body pointer-events:none, and traps
    // focus — so the panel sitting beside the drawer would be VISIBLE BUT DEAD, and the
    // click that reached it wouldn't be inside [data-athena-dock] any more, so the guards
    // below wouldn't fire and the drawer would close. Non-modal is what makes coexistence
    // real; the overlay still dismisses on a canvas click. Same call CreateAssignmentWizard
    // makes for the same reason.
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        // Offset only where there is room: at md (768px) a 448px drawer pushed 384px left
        // starts at −64px and clips its own form fields off-screen, and until ~1280px it
        // covers the whole pushed canvas anyway. Below xl the drawer just covers the dock,
        // which is the right answer on a narrow screen — one thing at a time.
        className={`w-full overflow-y-auto sm:max-w-md ${dockOpen ? 'xl:mr-[var(--athena-dock-w)]' : ''}`}
        onPointerDownOutside={keepOpenOverAthena}
        onInteractOutside={keepOpenOverAthena}
      >
        <SheetHeader>
          <SheetTitle>Quiz settings</SheetTitle>
          <SheetDescription>
            Rules for the whole quiz. Each question&apos;s own settings live next to the
            question.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-8">
          {/* Roadmap placement — the module this quiz belongs to. Saved as soon
              as it's picked (not just at publish). The slot is reserved while the
              module list loads (no pop-in), then hidden if the section has none. */}
          {onPlacementChange && placementModules !== undefined && (placementModules === null || placementModules.length > 0) && (
            <div className="mb-6 space-y-2">
              <Label htmlFor="settings-quiz-module" className="text-sm font-medium">
                Module it belongs to{' '}
                <span className="font-normal text-muted-foreground">· optional</span>
              </Label>
              {placementModules === null ? (
                <p className="text-xs text-muted-foreground">Loading modules…</p>
              ) : (
                <>
                  <Select value={placementModuleId || ''} onValueChange={onPlacementChange}>
                    <SelectTrigger id="settings-quiz-module" className="w-full">
                      <SelectValue placeholder="Pick a module…" />
                    </SelectTrigger>
                    <SelectContent>
                      {placementModules.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.weekNumber ? `Week ${m.weekNumber} · ` : ''}{m.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Shows the quiz under this module on the roadmap. Required to publish; you can change it any time.
                  </p>
                </>
              )}
            </div>
          )}

          <QuizInfoStep form={form} sectionId={sectionId} quizId={quizId} hideTitle />

          {/* Danger zone — deleting the quiz removes it (and any student attempts)
              for good, so it sits apart at the very end. */}
          {onDeleteQuiz && (
            <div className="mt-8 border-t pt-6">
              <Button
                type="button"
                variant="outline"
                onClick={onDeleteQuiz}
                className="w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Delete quiz
              </Button>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                Removes the quiz and all its student attempts. This can&apos;t be undone.
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
