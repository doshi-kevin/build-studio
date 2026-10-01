'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { bindSkillSlotAction } from '@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions'

/** Links each of the tool's skill slots to one of this course's skills. The tool itself
 * only ever sees the skill's name. */
export function SkillSlotLinks({
  sectionId,
  installationId,
  slots,
  skills,
}: {
  sectionId: string
  installationId: string
  slots: { key: string; label: string; skillId: string | null }[]
  /** Null when the course's skills couldn't be read. */
  skills: { id: string; name: string }[] | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // The professor's pick shows at once, before the save and the refresh finish.
  const [picked, setPicked] = useState<Record<string, string>>({})

  if (!skills) return <p>Couldn’t load this course’s skills just now. Close this and open it again.</p>
  if (skills.length === 0) {
    return (
      <p>
        This tool needs course skills to count toward, and this course has none confirmed yet.{' '}
        <Link href={`/professor/courses/${sectionId}/roadmap`} className="font-medium text-foreground underline underline-offset-4">
          Add skills on the Roadmap
        </Link>
        , then come back here.
      </p>
    )
  }

  const bind = (slotKey: string, skillId: string) => {
    setPicked((p) => ({ ...p, [slotKey]: skillId }))
    startTransition(async () => {
      const result = await bindSkillSlotAction(sectionId, installationId, slotKey, skillId)
      if ('error' in result) {
        setPicked((p) => {
          const next = { ...p }
          delete next[slotKey]
          return next
        })
        toast.error(result.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      {slots.map((slot) => (
        <div key={slot.key} className="space-y-1">
          <Label htmlFor={`slot-${slot.key}`} className="text-foreground">
            {slot.label}
          </Label>
          <Select value={picked[slot.key] ?? slot.skillId ?? undefined} onValueChange={(v) => bind(slot.key, v)} disabled={pending}>
            <SelectTrigger id={`slot-${slot.key}`} className="min-h-11 w-full">
              <SelectValue placeholder="Choose a course skill" />
            </SelectTrigger>
            <SelectContent>
              {skills.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  )
}
