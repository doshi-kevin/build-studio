// Starter-template generator for the course About page.
// Returns a small set of blocks pre-filled with the course's metadata so a
// professor can land on the editor with a usable scaffold instead of an empty
// canvas. The professor edits or removes any block they don't want.

import type { AboutBlock } from '@/lib/validations/course-about'
import type { CourseInfo } from '../AboutPageBuilder'
import {
  createHeroBlock,
  createTextBlock,
  createOutcomesBlock,
  createSyllabusBlock,
} from './block-factory'

export function getStarterTemplate(course: CourseInfo): AboutBlock[] {
  const hero = createHeroBlock()
  if (hero.type === 'hero') {
    hero.data.title = course.title || ''
    hero.data.subtitle = course.code || ''
    hero.data.instructor = course.instructor || ''
    hero.data.semester = course.semester || ''
    hero.data.credits = course.credits ? `${course.credits} credits` : ''
  }

  /* Empty text block — TipTap shows its built-in placeholder so the prof has
     a clear "write here" affordance for their course description. */
  const description = createTextBlock()

  /* Three blank outcome rows — gives the prof a structure to fill, but no
     placeholder text that could ship to students if they forget to edit. */
  const outcomes = createOutcomesBlock()
  if (outcomes.type === 'learning-outcomes') {
    outcomes.data.outcomes = [
      { id: crypto.randomUUID(), text: '', isCore: true },
      { id: crypto.randomUUID(), text: '', isCore: true },
      { id: crypto.randomUUID(), text: '', isCore: true },
    ]
  }

  /* Syllabus already starts with one blank week 1 row from its factory. */
  const syllabus = createSyllabusBlock()

  return [hero, description, outcomes, syllabus]
}
