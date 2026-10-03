/**
 * Step 11's product-quality benchmark: ordinary professor requests, each with explicit
 * pass/fail criteria for the behaviour that matters, read from what the build committed
 * (manifest, both views, sample data). Visual quality is judged separately, by people and a
 * UX review over the screenshots product.ts saves; nothing here pretends to score it.
 *
 * Criteria are about the platform contract the tool must use (who writes what, which
 * capability, whether students can change something), never about exact code, so any good
 * build passes and none is special-cased.
 */
import type { MaterialPage } from './cases'

export interface Built {
  status: string
  manifest: {
    views: Record<'student' | 'professor', { capabilities: string[] }>
    collections: Record<string, { access: string; fields: Record<string, string> }>
    purpose: { category: string }
  } | null
  professor: string
  student: string
  sample: Record<string, unknown[]> | null
  /** Each build's status in order, for cases with follow-ups. */
  statuses: string[]
  /** The run asked the professor something. */
  asked: boolean
}

export interface ProductCase {
  id: string
  title: string
  request: string
  /** Asked after the first build, each on the draft the one before committed. */
  followUps?: string[]
  answer?: string
  material?: MaterialPage[]
  /** Explicit pass/fail checks; every one must hold. */
  checks: (b: Built) => Record<string, boolean>
}

const accessOf = (b: Built, access: string) => Object.values(b.manifest?.collections ?? {}).some((c) => c.access === access)
const profCaps = (b: Built) => b.manifest?.views.professor.capabilities ?? []
const studentCaps = (b: Built) => b.manifest?.views.student.capabilities ?? []
/** A view that writes nothing: no write call of any kind. */
const writesNothing = (src: string) => !/\b(create|update|remove|saveMany)\(|records\.(create|update|delete|batch)/.test(src)
const uses = (src: string, ...names: string[]) => names.some((n) => new RegExp(`<${n}\\b`).test(src))
const RICH = ['StatCard', 'DataTable', 'RosterTable', 'Badge', 'Tabs', 'ProgressBar', 'BarChart', 'SegmentedControl', 'ListItem', 'Section']

/** What every case must show, whatever it is. */
export function common(b: Built): Record<string, boolean> {
  return {
    preview_ready: b.statuses[0] === 'preview_ready' && b.statuses.every((s) => s === 'preview_ready' || s === 'completed'),
    no_refusal: !b.statuses.includes('blocked'),
    sample_data_written: b.sample !== null && Object.values(b.sample).some((l) => l.length > 0),
    professor_uses_rich_kit: RICH.filter((n) => uses(b.professor, n)).length >= 2,
    student_uses_rich_kit: RICH.some((n) => uses(b.student, n)),
    no_placeholder_copy: !/Sample text|Lorem ipsum|TODO/i.test(b.professor + b.student),
  }
}

const LECTURE: MaterialPage[] = [
  {
    key: 'p:b1b2c3d4-2222-4222-8222-00000000000a:1',
    label: 'Week 6: Photosynthesis (lecture), page 1',
    disclosure: 'released',
    opensAt: null,
    text: 'Photosynthesis converts light energy into chemical energy. The light-dependent reactions in the thylakoid membranes split water, release oxygen and make ATP and NADPH. The Calvin cycle in the stroma fixes carbon dioxide with the enzyme RuBisCO to make G3P.',
  },
  {
    key: 'p:b1b2c3d4-2222-4222-8222-00000000000a:2',
    label: 'Week 6: Photosynthesis (lecture), page 2',
    disclosure: 'released',
    opensAt: null,
    text: 'Chlorophyll a absorbs red and blue light. Photosystem II comes before photosystem I in the electron transport chain. C4 and CAM plants reduce photorespiration in hot, dry climates.',
  },
]

export const PRODUCT_CASES: ProductCase[] = [
  {
    id: 'G-attendance',
    title: 'A + B: attendance tracker, then professors mark',
    request: 'Build an attendance tracker for my class.',
    followUps: ['Students shouldn’t mark themselves. Professors should mark them.'],
    checks: (b) => ({
      roster_capability: profCaps(b).includes('course.roster'),
      student_has_no_roster: !studentCaps(b).includes('course.roster'),
      staff_marks_students: accessOf(b, 'staffPerStudent'),
      roster_table: uses(b.professor, 'RosterTable'),
      bulk_action: /saveMany\(/.test(b.professor),
      student_view_read_only: writesNothing(b.student),
      history_in_professor_view: /history|past|previous|by date|dates/i.test(b.professor),
    }),
  },
  {
    id: 'G2-checkin-then-staff',
    title: 'Follow-up changes who marks: students check in, then professors mark',
    request: 'Build an attendance check-in where students mark themselves present for each class.',
    followUps: ['Students shouldn’t mark themselves. Professors should mark them.'],
    checks: (b) => ({
      staff_marks_students: accessOf(b, 'staffPerStudent'),
      roster_capability: profCaps(b).includes('course.roster'),
      student_cannot_write_after_followup: writesNothing(b.student),
      student_has_no_roster: !studentCaps(b).includes('course.roster'),
      follow_up_not_refused: b.statuses.length === 2 && b.statuses[1] !== 'blocked',
    }),
  },
  {
    id: 'C-lecture-flashcards',
    title: 'Flashcards from this week’s lecture',
    request: 'Build flashcards from this week’s lecture.',
    material: LECTURE,
    checks: (b) => ({
      professor_authors_cards: accessOf(b, 'shared'),
      lecture_terms_in_suggestions_or_sample: /photosynth|calvin|chlorophyll|thylakoid|rubisco/i.test(b.professor + JSON.stringify(b.sample ?? {})),
      no_lecture_text_in_student_view: !/RuBisCO|thylakoid/i.test(b.student),
    }),
  },
  {
    id: 'D-anonymous-feedback',
    title: 'Anonymous feedback with themes',
    request: 'Build an anonymous feedback tool where students can submit feedback and I can see themes.',
    checks: (b) => ({
      students_submit: accessOf(b, 'perStudent'),
      professor_never_shows_who: !/\.student\b/.test(b.professor) && !uses(b.professor, 'RosterTable') && !profCaps(b).includes('course.roster'),
      themes_grouped: /theme|topic|categor/i.test(b.professor),
      says_anonymous_to_students: /anonymous/i.test(b.student),
    }),
  },
  {
    id: 'E-office-hours-queue',
    title: 'Office-hours queue',
    request: 'Build an office-hours queue where students join the queue and I can call the next student.',
    checks: (b) => ({
      students_join: accessOf(b, 'perStudent'),
      staff_calls: accessOf(b, 'staffPerStudent'),
      call_next_action: /next|call/i.test(b.professor),
      shows_who_is_waiting: uses(b.professor, 'RosterTable'),
      student_sees_place_or_called: /position|place|called|your turn/i.test(b.student),
    }),
  },
  {
    id: 'B2-participation',
    title: 'Participation tracker',
    request: 'I want to track class participation: give students points when they contribute in class.',
    checks: (b) => ({ roster_capability: profCaps(b).includes('course.roster'), staff_writes_points: accessOf(b, 'staffPerStudent'), student_view_read_only: writesNothing(b.student) }),
  },
  {
    id: 'B3-reading-tracker',
    title: 'Reading tracker',
    request: 'Build a reading tracker where students log the readings they finished and I can see who is keeping up.',
    checks: (b) => ({ students_log: accessOf(b, 'perStudent'), professor_sees_progress: /progress|keeping up|finished|completed/i.test(b.professor) }),
  },
  {
    id: 'B4-assignment-dashboard',
    title: 'Assignment progress dashboard',
    request: 'Make an assignment progress dashboard so students can mark how far along they are on each assignment and I can see where the class is.',
    checks: (b) => ({ reads_assignments: [...profCaps(b), ...studentCaps(b)].includes('course.assignments'), students_report: accessOf(b, 'perStudent') }),
  },
  {
    id: 'B5-peer-review',
    title: 'Peer review',
    request: 'Build a peer review tool where students give feedback on each other’s project drafts.',
    answer: 'Students paste a link or a short summary of their draft, and classmates leave written feedback with a rating.',
    checks: (b) => ({ students_write: accessOf(b, 'perStudent'), no_names_in_student_view: !uses(b.student, 'RosterTable') }),
  },
  {
    id: 'B6-team-formation',
    title: 'Team formation',
    request: 'Help me form project teams of four from my class.',
    checks: (b) => ({ roster_capability: profCaps(b).includes('course.roster'), team_per_student: accessOf(b, 'staffPerStudent'), student_sees_own_team: /team/i.test(b.student) }),
  },
  {
    id: 'B7-mastery',
    title: 'Concept mastery dashboard',
    request: 'Build a concept mastery dashboard: students rate their confidence on each concept and I see which concepts the class struggles with.',
    checks: (b) => ({ students_rate: accessOf(b, 'perStudent'), professor_chart: uses(b.professor, 'BarChart', 'ProgressBar') }),
  },
  {
    id: 'B8-discussion-board',
    title: 'Discussion prompt board',
    request: 'Create a discussion prompt board where I post prompts and students respond.',
    checks: (b) => ({ professor_posts: accessOf(b, 'shared'), students_respond: accessOf(b, 'perStudent') }),
  },
  {
    id: 'B9-quiz-game',
    title: 'Quiz game',
    request: 'Make a quick quiz game for review day.',
    answer: 'Multiple-choice questions I write; students answer and see their score at the end.',
    checks: (b) => ({ answers_kept_from_students: accessOf(b, 'staffOnly') || !/correct/i.test(b.student), students_answer: accessOf(b, 'perStudent') }),
  },
]
