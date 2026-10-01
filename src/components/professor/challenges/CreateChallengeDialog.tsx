/**
 * CreateChallengeDialog — Form dialog for professors to create a new challenge.
 *
 * Uses react-hook-form + zodResolver for validation.
 * Calls createChallenge server action.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  createChallengeSchema,
  CHALLENGE_TYPES,
  CHALLENGE_TYPE_LABELS,
  CHALLENGE_DIFFICULTIES,
  CHALLENGE_DIFFICULTY_LABELS,
  type CreateChallengeInput,
} from '@/lib/validations/challenge'
import { createChallenge } from '@/app/(dashboard)/professor/courses/[sectionId]/challenges/actions'
import { SkillPickerDialog } from './SkillPickerDialog'

interface ChallengeBadge {
  id: string
  name: string
  icon: string
}

interface CreateChallengeDialogProps {
  sectionId: string
  badges: ChallengeBadge[]
  /** Section skills the professor can link this challenge to (Slice A). */
  skills?: { id: string; name: string }[]
}

export function CreateChallengeDialog({ sectionId, badges, skills = [] }: CreateChallengeDialogProps) {
  const [open, setOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const router = useRouter()

  const form = useForm<CreateChallengeInput>({
    resolver: zodResolver(createChallengeSchema) as Resolver<CreateChallengeInput>,
    defaultValues: {
      title: '',
      description: '',
      type: 'general',
      difficulty: 'medium',
      points: 10,
      bonus_points: 0,
      badge_id: null,
      max_claims: null,
      due_at: null,
      skill_ids: [],
    },
  })

  const onSubmit = async (data: CreateChallengeInput) => {
    setIsSubmitting(true)
    try {
      const result = await createChallenge(sectionId, data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Challenge created as draft')
      setOpen(false)
      form.reset()
      router.refresh()
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  /* Every close path goes through here (#703 part 3). `form.reset()` used to run only after a
     SUCCESSFUL create, so cancelling left the previous title, points and due date in the form and
     the next "New challenge" opened pre-filled with an abandoned draft, which reads as a saved
     one.

     It has to be one function rather than a reset inside `onOpenChange`, because Cancel called
     `setOpen(false)` directly and bypassed `onOpenChange` completely. Resetting in only one of
     the two places looks right and fixes nothing, which is what a test caught here.

     Deliberately not reset on ERROR: a failed submit keeps what the professor typed. */
  const setOpenAndReset = (next: boolean) => {
    setOpen(next)
    if (!next) form.reset()
  }

  // Surface validation failures instead of the submit silently doing nothing
  // (e.g. a field-level error the form doesn't render inline).
  const onInvalid = () => {
    toast.error('Please check the highlighted fields and try again.')
  }

  return (
    <Dialog open={open} onOpenChange={setOpenAndReset}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          New challenge
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Challenge</DialogTitle>
          <DialogDescription>
            Create a new challenge for your students. It will start as a draft.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title *</FormLabel>
                  <FormControl>
                    <Input placeholder="Challenge title" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Describe the challenge, requirements, and expected output..."
                      className="resize-none"
                      rows={4}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CHALLENGE_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {CHALLENGE_TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="difficulty"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Difficulty</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select difficulty" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CHALLENGE_DIFFICULTIES.map((d) => (
                          <SelectItem key={d} value={d}>
                            {CHALLENGE_DIFFICULTY_LABELS[d]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="points"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Points</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={1000}
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : 0)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="bonus_points"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bonus Points</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={500}
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : 0)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="badge_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Award Badge</FormLabel>
                    <Select
                      onValueChange={(v) => field.onChange(v === 'none' ? null : v)}
                      defaultValue={field.value || 'none'}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="No badge" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">No badge</SelectItem>
                        {badges.map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.icon} {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="due_at"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Due Date</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        {...field}
                        value={field.value || ''}
                        onChange={(e) => field.onChange(e.target.value || null)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {skills.length > 0 && (
              <FormField
                control={form.control}
                name="skill_ids"
                render={({ field }) => {
                  const selected = field.value ?? []
                  const selectedNames = selected
                    .map((id) => skills.find((s) => s.id === id)?.name)
                    .filter((n): n is string => Boolean(n))
                  const shown = selectedNames.slice(0, 5)
                  const extra = selectedNames.length - shown.length
                  return (
                    <FormItem>
                      <FormLabel>Skills this builds</FormLabel>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SkillPickerDialog skills={skills} selected={selected} onChange={field.onChange} />
                        {shown.length === 0 ? (
                          <span className="text-sm text-muted-foreground">No skills linked yet</span>
                        ) : (
                          <>
                            {shown.map((name) => (
                              <Badge key={name} variant="secondary" className="font-normal">
                                {name}
                              </Badge>
                            ))}
                            {extra > 0 && (
                              <Badge variant="outline" className="font-normal text-muted-foreground">
                                +{extra} more
                              </Badge>
                            )}
                          </>
                        )}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )
                }}
              />
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpenAndReset(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Creating…' : 'Create Challenge'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
