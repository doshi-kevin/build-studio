// Zod schemas for grade-related server action inputs.
import { z } from 'zod'

export const updateGradeSchema = z.object({
  finalGrade: z
    .enum(['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'])
    .nullable(),
  finalScore: z.number().min(0).max(100).nullable(),
})

export type UpdateGradeInput = z.infer<typeof updateGradeSchema>
