// Step 1 of the quiz wizard — quiz title, description, publish mode, and all settings.
// All options are visible on the page, organized by category.

'use client'

import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { UseFormReturn } from 'react-hook-form'
import { Input } from '@/components/ui/input'
import { NumericInput } from '@/components/ui/numeric-input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FileUpload } from '@/components/ui/file-upload'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { deleteFile } from '@/lib/supabase/storage'
import {
  EXPLANATION_TIMINGS,
  EXPLANATION_TIMING_LABELS,
  MAX_ATTEMPTS_CEILING,
} from '@/lib/validations/quiz'
import type { WizardFormValues } from './QuizStudio'

interface QuizInfoStepProps {
  form: UseFormReturn<WizardFormValues>
  sectionId: string
  quizId?: string
  /** Hide the Title field — the studio edits it inline in its header.
   *  The description stays here (it left the studio header to save space). */
  hideTitle?: boolean
}

export function QuizInfoStep({ form, sectionId, quizId, hideTitle }: QuizInfoStepProps) {
  const allowFormulaSheet = form.watch('allowFormulaSheet')
  const negativeMarking = form.watch('negativeMarking')

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* ── Basic Info ── */}
      <section className="space-y-4">
        <SectionLabel>Basic Info</SectionLabel>

        {!hideTitle && (
          <div className="space-y-2">
            <Label htmlFor="quiz-title">Title *</Label>
            <Input
              id="quiz-title"
              placeholder="e.g., Midterm Quiz — Chapter 1-5"
              {...form.register('title')}
            />
            {form.formState.errors.title && (
              <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="quiz-description">Description</Label>
          <Textarea
            id="quiz-description"
            placeholder="Optional instructions or context for students..."
            rows={3}
            maxLength={2000}
            className="resize-none"
            {...form.register('description')}
          />
        </div>
      </section>

      {/* ── Quiz Rules ── */}
      <section className="space-y-4 border-t pt-6">
        <SectionLabel>Quiz Rules</SectionLabel>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Time Limit (minutes)</Label>
            <NumericInput
              min={1}
              max={480}
              placeholder="No limit"
              value={form.watch('timeLimitMinutes') ?? ''}
              onChange={(v) =>
                form.setValue('timeLimitMinutes', v ? parseInt(v) : null)
              }
            />
          </div>

          <div className="space-y-2">
            <Label>Max Attempts</Label>
            <NumericInput
              spinner
              min={1}
              // Same ceiling the server enforces, so an over-large value clamps here
              // instead of failing the save with a raw validator message (#43).
              max={MAX_ATTEMPTS_CEILING}
              placeholder="No limit"
              value={form.watch('maxAttempts') ?? ''}
              onChange={(v) => form.setValue('maxAttempts', v ? parseInt(v) : null)}
            />
            <p className="text-[11px] text-muted-foreground">Leave empty for unlimited retakes.</p>
          </div>

          <div className="space-y-2">
            <Label>Pass Threshold (%)</Label>
            <NumericInput
              min={0}
              max={100}
              value={form.watch('passThreshold')}
              onChange={(v) => form.setValue('passThreshold', parseInt(v) || 0)}
            />
          </div>

          <div className="space-y-2">
            <Label>Due Date</Label>
            <Input
              type="date"
              value={form.watch('dueDate') ?? ''}
              onChange={(e) => form.setValue('dueDate', e.target.value || null)}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              checked={form.watch('shuffleQuestions')}
              onCheckedChange={(checked) => form.setValue('shuffleQuestions', checked)}
            />
            <Label>Shuffle questions for each student</Label>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              checked={form.watch('shuffleAnswers')}
              onCheckedChange={(checked) => form.setValue('shuffleAnswers', checked)}
            />
            <Label>Shuffle answer choices</Label>
          </div>
        </div>
      </section>

      {/* ── Display & Feedback ── */}
      <section className="space-y-4 border-t pt-6">
        <SectionLabel>Display &amp; Feedback</SectionLabel>

        <div className="space-y-2">
          <Label>Show Explanations</Label>
          <Select
            value={form.watch('showExplanations') ?? 'after_submission'}
            onValueChange={(v) => form.setValue('showExplanations', v as WizardFormValues['showExplanations'])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPLANATION_TIMINGS.map((timing) => (
                <SelectItem key={timing} value={timing}>
                  {EXPLANATION_TIMING_LABELS[timing]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            checked={form.watch('showLeaderboard') ?? false}
            onCheckedChange={(checked) => form.setValue('showLeaderboard', checked)}
          />
          <Label>Show Leaderboard</Label>
        </div>
      </section>

      {/* ── Resources ── */}
      <section className="space-y-4 border-t pt-6">
        <SectionLabel>Resources</SectionLabel>

        <div className="flex items-center gap-3">
          <Switch
            checked={allowFormulaSheet ?? false}
            onCheckedChange={(checked) => form.setValue('allowFormulaSheet', checked)}
          />
          <Label>Allow Formula Sheet</Label>
        </div>

        {allowFormulaSheet && !form.watch('formulaSheetUrl') && (
          <p className="text-xs text-warning-muted-foreground pl-10">
            No file uploaded yet. Students won&apos;t see a formula sheet until you upload one.
          </p>
        )}

        {allowFormulaSheet && (
          <div className="pl-10 space-y-2">
            <Label className="text-xs text-muted-foreground">Upload formula sheet (PDF or image)</Label>
            <FileUpload
              folder={`formula-sheets/${sectionId}/${quizId || 'new'}`}
              accept=".pdf,.png,.jpg,.jpeg"
              maxSize={10 * 1024 * 1024}
              existingFile={
                form.watch('formulaSheetUrl')
                  ? {
                      url: form.watch('formulaSheetUrl')!,
                      fileName: form.watch('formulaSheetPath')?.split('/').pop() || 'formula-sheet',
                      fileSize: 0,
                    }
                  : null
              }
              onUpload={(result) => {
                form.setValue('formulaSheetUrl', result.url)
                form.setValue('formulaSheetPath', result.path)
              }}
              onRemove={async () => {
                const path = form.getValues('formulaSheetPath')
                if (path) await deleteFile(path)
                form.setValue('formulaSheetUrl', null)
                form.setValue('formulaSheetPath', null)
              }}
            />
          </div>
        )}
      </section>

      {/* ── Scoring ── */}
      <section className="space-y-4 border-t pt-6">
        <SectionLabel>Scoring</SectionLabel>

        <div className="flex items-center gap-3">
          <Switch
            checked={negativeMarking ?? false}
            onCheckedChange={(checked) => form.setValue('negativeMarking', checked)}
          />
          <Label>Negative Marking</Label>
        </div>

        {negativeMarking && (
          <div className="space-y-2 pl-10">
            <Label className="text-xs text-muted-foreground">Penalty (% of question points)</Label>
            <NumericInput
              min={0}
              max={100}
              value={Math.round((form.watch('negativeMarkingPenalty') ?? 0.25) * 100)}
              onChange={(v) =>
                form.setValue('negativeMarkingPenalty', (parseInt(v) || 0) / 100)
              }
              className="w-24"
            />
            <p className="text-[11px] text-muted-foreground">
              e.g. 25% on a 4-point question deducts 1 point for a wrong answer. Unanswered questions are not penalized.
            </p>
          </div>
        )}
      </section>

      {/* ── Adaptive (CCAT) ── */}
      <section className="space-y-4 border-t pt-6">
        <div className="flex items-center gap-2">
          <SectionLabel>Adaptive Quiz</SectionLabel>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">Beta</Badge>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            checked={form.watch('adaptiveMode') ?? false}
            onCheckedChange={(checked) => form.setValue('adaptiveMode', checked)}
          />
          <div className="flex items-center gap-1.5">
            <Label>Enable Adaptive Mode</Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  <p className="text-xs">
                    Serves one question at a time, choosing each next item to be most
                    informative about the student&apos;s ability (IRT / CCAT). Free-text
                    &ldquo;explanation&rdquo; questions are AI-graded against a rubric. The
                    student gets a grade plus a diagnostic ability estimate.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        {form.watch('adaptiveMode') && (
          <div className="space-y-5 pl-10">
            {/* Stopping rule */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Stopping rule</Label>
              <ToggleGroup
                type="single"
                value={form.watch('stopMode') ?? 'fixed'}
                onValueChange={(v) => { if (v === 'fixed' || v === 'precision') form.setValue('stopMode', v) }}
                className="justify-start"
              >
                <ToggleGroupItem value="fixed" className="text-xs">Fixed length</ToggleGroupItem>
                <ToggleGroupItem value="precision" className="text-xs">Target precision</ToggleGroupItem>
              </ToggleGroup>
              <p className="text-[11px] text-muted-foreground">
                {form.watch('stopMode') === 'precision'
                  ? 'Keep asking until the ability estimate is precise enough (or the cap is hit).'
                  : 'Asks every question in the quiz, choosing the order adaptively.'}
              </p>
            </div>

            {form.watch('stopMode') === 'precision' && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Target precision (SE)</Label>
                <NumericInput
                  decimal
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={form.watch('targetSe') ?? 0.3}
                  onChange={(v) => form.setValue('targetSe', parseFloat(v) || 0.3)}
                  className="w-24"
                />
                <p className="text-[11px] text-muted-foreground">Lower = more questions, more confident score. 0.3 is a good default.</p>
              </div>
            )}

            {/* Difficulty matching (λ) */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Difficulty matching</Label>
              <Select
                value={String(form.watch('selectLambda') ?? 0.5)}
                onValueChange={(v) => form.setValue('selectLambda', parseFloat(v))}
              >
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Off — pure max-information</SelectItem>
                  <SelectItem value="0.5">Balanced (recommended)</SelectItem>
                  <SelectItem value="1">Strong on-level matching</SelectItem>
                  <SelectItem value="2">Strict on-level matching</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Higher keeps questions closer to the student&apos;s level so strugglers aren&apos;t handed items far above them.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* ── Proctoring ── */}
      <section className="space-y-4 border-t pt-6">
        <SectionLabel>Proctoring</SectionLabel>

        <div className="flex items-center gap-3">
          <Switch
            checked={form.watch('proctoringEnabled') ?? false}
            onCheckedChange={(checked) => {
              form.setValue('proctoringEnabled', checked)
              if (!checked) form.setValue('videoProctoringEnabled', false)
            }}
          />
          <div className="flex items-center gap-1.5">
            <Label>Enable Proctoring</Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  <p className="text-xs">
                    When enabled, the quiz will track keyboard activity, tab switches,
                    and clipboard operations (copy/paste/cut) during student attempts.
                    Students will see a notice that the quiz is proctored.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            checked={form.watch('videoProctoringEnabled') ?? false}
            onCheckedChange={(checked) => form.setValue('videoProctoringEnabled', checked)}
            disabled={!form.watch('proctoringEnabled')}
          />
          <div className="flex items-center gap-1.5">
            <Label className={`flex items-center gap-1.5 ${!form.watch('proctoringEnabled') ? 'text-muted-foreground' : ''}`}>
              Enable Video Proctoring
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">Beta</Badge>
            </Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  <p className="text-xs">
                    Multi-face detection and phone detection run in the student&apos;s browser
                    using their webcam. No video is recorded — only snapshots are taken when
                    violations are detected. Requires base proctoring to be enabled.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </section>
    </div>
  )
}

/** Small uppercase section label used to categorize settings groups. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
      {children}
    </h3>
  )
}
