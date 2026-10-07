/**
 * The canonical professor requests for studio-generation-quality-v1, in two tiers:
 *
 *   core  Tier 1, Core Educational Workflows: Q01 to Q20, approved in Step 12A.1.
 *   deep  Tier 2, Complex Product Reasoning: D01 to D08, approved in Step 12A.3
 *         (docs/designs/studio/studio-generation-quality-tier2.md).
 *
 * Only `prompt` ever reaches the builder (build.ts takes a string and holds the scripted
 * professor's neutral answer and the synthetic course itself). Goals and hints are
 * for the judge alone: they say what a domain expert would expect, not a checklist, so a
 * different good solution can score as well. `guidance` is for people reviewing results
 * and reaches neither the builder nor the judge. Tests check that none of them reaches a
 * model input during a build.
 *
 * The Tier 2 holdouts are `sealed`: this file keeps only what running them needs. Their
 * goals, hints and guidance live in the local sealed file (sealed.ts), which only the
 * Step 12A.4 baseline loads, so they can't steer Step 12 tuning.
 */
import { STUDIO_RECORD_MAX_BYTES } from '../../src/lib/studio/limits'
import { KIT_RECORDS_LOAD_MAX } from './platform-card'

export type Tier = 'core' | 'deep'

export const TIER_LABEL: Record<Tier, string> = {
  core: 'Tier 1, Core Educational Workflows',
  deep: 'Tier 2, Complex Product Reasoning',
}

/** The kinds of product reasoning a Tier 2 case asks for. */
export type Reasoning = 'runtime-structure' | 'branching' | 'algorithmic' | 'multi-role' | 'longitudinal' | 'phases' | 'synthesis' | 'platform-limits'

/** Review notes for a Tier 2 development case. Guidance for reading a result, not a checklist. */
export interface CaseGuidance {
  /** The platform rules that shape this tool. */
  constraints: string[]
  /** What a basic build looks like, which should score clearly lower. */
  shallow: string
  /** What a thoughtful build shows. One of several good designs. */
  strong: string
  capabilities: string[]
  /** What the tool must not claim or depend on, because the platform doesn't provide it. */
  mustNotAssume: string[]
}

export interface QualityCase {
  id: string
  prompt: string
  tier: Tier
  /** The broad kind of workflow. */
  category: string
  /** Tier 2 only: the kinds of reasoning the case tests. */
  reasoning?: readonly Reasoning[]
  /** The builder's instructions already describe this kind of workflow ("Patterns that work"). */
  inPattern: boolean
  /** Null only for a sealed case, until the baseline loads its sealed guidance. */
  professorGoal: string | null
  studentGoal: string | null
  hints: string[]
  /** Tier 2 development cases only. */
  guidance?: CaseGuidance
  /** Process holdout: its detailed results aren't inspected while tuning Step 12. */
  set: 'dev' | 'holdout'
  /** A Tier 2 holdout whose goals, hints and guidance are kept out of this file. */
  sealed?: true
  /** One of the six cases built five times to measure nondeterminism. */
  variance: boolean
}

const KB = (bytes: number) => `${bytes / 1024} KB`

export const QUALITY_CASES: readonly QualityCase[] = [
  {
    id: 'Q01-attendance',
    prompt: 'I want to take attendance in my lectures this semester.',
    tier: 'core',
    category: 'Staff tracking',
    inPattern: true,
    professorGoal: 'Record each session’s attendance quickly and see patterns over the term.',
    studentGoal: 'See their own attendance record.',
    hints: ['sessions or dates', 'whole-class marking with exceptions', 'history and per-student rates', 'read-only for students'],
    set: 'dev',
    variance: true,
  },
  {
    id: 'Q02-office-hours-booking',
    prompt: 'Can you make something so students can sign up for my office hours?',
    tier: 'core',
    category: 'Scheduling',
    inPattern: true,
    professorGoal: 'Publish office-hour slots and see who is coming.',
    studentGoal: 'Book a slot and cancel it if plans change.',
    hints: ['the professor defines slots', 'capacity, and no double booking', 'a student can cancel their booking', 'an upcoming list for the professor'],
    set: 'dev',
    variance: true,
  },
  {
    id: 'Q03-participation',
    prompt: 'I’d like to keep track of who speaks up in discussion section.',
    tier: 'core',
    category: 'Staff tracking',
    inPattern: true,
    professorGoal: 'Note contributions during class with almost no effort.',
    studentGoal: 'See their own contributions.',
    hints: ['one action per contribution', 'grouped by session', 'quiet students easy to spot'],
    set: 'dev',
    variance: false,
  },
  {
    id: 'Q04-peer-review',
    prompt: 'My students write essay drafts and I want them to review each other’s before the final deadline.',
    tier: 'core',
    category: 'Multi-role workflow',
    inPattern: false,
    professorGoal: 'Run a review round and see that it is getting done.',
    studentGoal: 'Give feedback on a classmate’s draft and read the feedback on their own.',
    hints: ['who reviews whom', 'structured feedback', 'the student sees feedback received', 'the professor sees completion', 'students can’t read each other’s records, so drafts and feedback must pass through staff, and a good tool says how'],
    set: 'dev',
    variance: true,
  },
  {
    id: 'Q05-exit-ticket',
    prompt: 'At the end of each lecture I want students to tell me what they’re still confused about.',
    tier: 'core',
    category: 'Quick submission',
    inPattern: false,
    professorGoal: 'See quickly what the class is confused about after each lecture.',
    studentGoal: 'Answer in under a minute.',
    hints: ['grouped by lecture', 'very little effort for students', 'grouped or summarised for the professor'],
    set: 'dev',
    variance: true,
  },
  {
    id: 'Q06-vocab-study',
    prompt: 'Give my students a way to study the key vocabulary for each unit.',
    tier: 'core',
    category: 'Author and use',
    inPattern: true,
    professorGoal: 'Add the terms for each unit.',
    studentGoal: 'Practise the terms and know which ones they still need to learn.',
    hints: ['organised by unit', 'a practice loop', 'progress or a still-learning set'],
    set: 'dev',
    variance: false,
  },
  {
    id: 'Q07-lab-checkoff',
    prompt: 'In lab, my TAs need to check students off when they finish each step.',
    tier: 'core',
    category: 'Staff tracking',
    inPattern: true,
    professorGoal: 'Check students off step by step, fast, during a lab session.',
    studentGoal: 'See which steps they have been checked off for.',
    hints: ['steps defined once', 'quick marking per student', 'who is stuck'],
    set: 'holdout',
    variance: false,
  },
  {
    id: 'Q08-group-formation',
    prompt: 'I need to put my students into project groups for the term.',
    tier: 'core',
    category: 'Grouping',
    inPattern: true,
    professorGoal: 'Form groups and adjust them.',
    studentGoal: 'Know which group they are in.',
    hints: ['a group size', 'a balanced assignment', 'easy moves between groups', 'ungrouped students visible'],
    set: 'dev',
    variance: true,
  },
  {
    id: 'Q09-reading-reflections',
    prompt: 'Students should write a short reflection on each week’s reading, and I want to keep up with them.',
    tier: 'core',
    category: 'Submit and review',
    inPattern: true,
    professorGoal: 'Read the reflections and see who is missing.',
    studentGoal: 'Submit a reflection each week.',
    hints: ['grouped by week', 'who has not submitted', 'professor feedback or acknowledgement students can see'],
    set: 'dev',
    variance: false,
  },
  {
    id: 'Q10-extension-requests',
    prompt: 'Students keep emailing me for extensions. I want one place for those requests.',
    tier: 'core',
    category: 'Request and approval',
    inPattern: true,
    professorGoal: 'Decide on requests quickly.',
    studentGoal: 'Ask for an extension and see the decision.',
    hints: ['a reason and a requested date', 'approve or deny with a note', 'pending requests first', 'no email: the platform can’t send it, so its absence isn’t a fault'],
    set: 'holdout',
    variance: false,
  },
  {
    id: 'Q11-anonymous-qa',
    prompt: 'Let students ask questions anonymously during lecture.',
    tier: 'core',
    category: 'Anonymous input',
    inPattern: true,
    professorGoal: 'See the open questions during lecture.',
    studentGoal: 'Ask a question without being identified.',
    hints: ['anonymity actually kept in the professor view', 'answered and open states', 'an order such as newest or most important'],
    set: 'dev',
    variance: false,
  },
  {
    id: 'Q12-project-milestones',
    prompt: 'My capstone teams have milestones through the semester and I want to see who’s on track.',
    tier: 'core',
    category: 'Progress tracking',
    inPattern: false,
    professorGoal: 'Spot teams at risk.',
    studentGoal: 'Report progress on their milestones.',
    hints: ['milestones with dates', 'a status per team', 'overdue milestones highlighted'],
    set: 'dev',
    variance: false,
  },
  {
    id: 'Q13-equipment-booking',
    prompt: 'We have three microscopes students can reserve for after-class work.',
    tier: 'core',
    category: 'Resource booking',
    inPattern: false,
    professorGoal: 'Manage when each microscope is available.',
    studentGoal: 'Reserve a microscope.',
    hints: ['per resource', 'no conflicting reservations', 'cancelling', 'today’s schedule'],
    set: 'holdout',
    variance: false,
  },
  {
    id: 'Q14-help-queue',
    prompt: 'During lab hours students wait for help and it gets chaotic. Help me manage who’s next.',
    tier: 'core',
    category: 'Queue',
    inPattern: true,
    professorGoal: 'Call the next student fairly.',
    studentGoal: 'Know their place in line.',
    hints: ['order kept', 'one step to call the next student', 'the student sees their position or that they are called', 'done or removed'],
    set: 'dev',
    variance: false,
  },
  {
    id: 'Q15-rubric-scoring',
    prompt: 'I want to score presentations with my rubric while students present.',
    tier: 'core',
    category: 'Assessment',
    inPattern: false,
    professorGoal: 'Score each presenter quickly, live.',
    studentGoal: 'See their own feedback, if the professor shares it.',
    hints: ['criteria and levels', 'quick entry per presenter', 'totals', 'whether students see scores is a deliberate choice'],
    set: 'holdout',
    variance: false,
  },
  {
    id: 'Q16-course-pulse',
    prompt: 'Every couple of weeks I’d like a quick check on how the course is going for students.',
    tier: 'core',
    category: 'Feedback',
    inPattern: true,
    professorGoal: 'See how students feel over time.',
    studentGoal: 'Give quick, honest feedback.',
    hints: ['repeated rounds', 'short questions', 'a trend from round to round', 'anonymity explained'],
    set: 'dev',
    variance: false,
  },
  {
    id: 'Q17-student-progress',
    prompt: 'Show students where they stand on this term’s assignments, and show me who’s falling behind.',
    tier: 'core',
    category: 'Course-linked',
    inPattern: true,
    professorGoal: 'Find students who are falling behind.',
    studentGoal: 'See where they stand.',
    hints: ['uses the course’s assignments', 'grades and submissions aren’t readable, which a good tool says honestly', 'a self-report or checklist approach'],
    set: 'holdout',
    variance: false,
  },
  {
    id: 'Q18-presentation-signup',
    prompt: 'Students need to pick a date for their in-class presentation.',
    tier: 'core',
    category: 'Sign-up',
    inPattern: true,
    professorGoal: 'Fill the presentation schedule.',
    studentGoal: 'Claim a date.',
    hints: ['dates and capacity', 'first come, first served', 'change or cancel', 'a schedule view'],
    set: 'dev',
    variance: false,
  },
  {
    id: 'Q19-discussion',
    prompt: 'I post a weekly discussion question and students should reply to it and to each other.',
    tier: 'core',
    category: 'Discussion',
    inPattern: true,
    professorGoal: 'Run the weekly discussion.',
    studentGoal: 'Post and reply to classmates.',
    hints: ['a prompt per week', 'a participation overview', 'students can’t read each other’s records, so replies to classmates need staff to share them, and a good tool is honest about it'],
    set: 'dev',
    variance: false,
  },
  {
    id: 'Q20-predict-reveal',
    prompt: 'Before I run the demonstration in class, I want students to predict what happens, then see how everyone predicted after I reveal it.',
    tier: 'core',
    category: 'Phased activity',
    inPattern: false,
    professorGoal: 'Open predictions, then reveal the result.',
    studentGoal: 'Predict, then compare with the class.',
    hints: ['phase control: open, locked, revealed', 'the class distribution shown only after the reveal'],
    set: 'holdout',
    variance: false,
  },

  // ── Tier 2, Complex Product Reasoning ──
  {
    id: 'D01-form-builder',
    prompt: 'Can you make me something like Google Forms? I want to write my own questions of different kinds, have students fill them in, and then see the results for each question.',
    tier: 'deep',
    category: 'Form builder',
    reasoning: ['runtime-structure', 'synthesis'],
    inPattern: false,
    professorGoal: 'Create forms with a mix of question types, open and close them, and read the results per question without exporting anything.',
    studentGoal: 'See which forms are open, answer one in a single sitting, and know it was received.',
    hints: [
      'the professor writes the questions in the tool, and question types fit the platform (short text, long text, one choice, several choices, a number or scale)',
      'the professor sets the options of each choice question',
      'forms can be opened and closed, and a student answers each form once or edits until it closes',
      'results per question suited to its type: counts for choices, an average or spread for numbers, a readable list for text',
      'how many students have answered, against the class size',
      `one response per student per form, so a large class stays within the ${KIT_RECORDS_LOAD_MAX} records a view loads`,
    ],
    guidance: {
      constraints: [
        'Collection fields are text, number or boolean and every field is required, so question options and answers are encoded as text.',
        'No file uploads, so no upload questions.',
        `A view loads at most ${KIT_RECORDS_LOAD_MAX} records of a collection.`,
      ],
      shallow: 'One fixed set of questions in the code, or text questions only. Results as one long table of raw answers. No open or closed state.',
      strong:
        'The professor builds a form in the tool, previews it as a student would see it, and opens it. The student view renders each question type with the right control. Results show a BarChart per choice question, a number summary, and text answers grouped by question, with the response count. One response record per student per form.',
      capabilities: ['records: shared forms and questions, perStudent responses', 'course.roster for the response count'],
      mustNotAssume: ['file uploads', 'required-field checks by the server', 'email reminders', 'export to a spreadsheet', 'who hasn’t answered without the roster'],
    },
    set: 'dev',
    variance: true,
  },
  {
    id: 'D02-branching-stories',
    prompt: 'I’d like to write short interactive case stories where students make choices and end up in different places depending on what they pick. I’ll write a few of these over the term.',
    tier: 'deep',
    category: 'Branching content',
    reasoning: ['branching', 'runtime-structure', 'longitudinal'],
    inPattern: false,
    professorGoal: null,
    studentGoal: null,
    hints: [],
    set: 'holdout',
    sealed: true,
    variance: false,
  },
  {
    id: 'D03-spaced-practice',
    prompt: 'I want my students to practise the key concepts all term instead of cramming. I’ll give them the questions, and it should keep bringing back the ones they struggle with.',
    tier: 'deep',
    category: 'Spaced practice',
    reasoning: ['algorithmic', 'longitudinal'],
    inPattern: true,
    professorGoal: 'Build a bank of questions once, then see which concepts the class finds hard and who has stopped practising.',
    studentGoal: 'Get today’s short set (due questions first, a few new ones), answer and self-check, and see progress towards mastery.',
    hints: [
      'a scheduling rule the student can feel: questions return by date, and missed ones come back sooner',
      'states such as new, learning and mastered, or an equivalent',
      'a daily set of sensible size instead of the whole bank every time',
      'the professor sees the most-missed questions and the students who have stopped practising',
      `a data model the professor's view can load for a large class: a view loads at most ${KIT_RECORDS_LOAD_MAX} records of a collection, so one record per student per question doesn't scale`,
      'honest that there are no reminders: questions come back when the student opens the tool',
    ],
    guidance: {
      constraints: [
        'today() gives the date only. Records carry createdAt and updatedAt timestamps.',
        'No notifications or reminders of any kind.',
        `A view loads at most ${KIT_RECORDS_LOAD_MAX} records of a collection, and a record holds at most ${KB(STUDIO_RECORD_MAX_BYTES)}.`,
      ],
      shallow: 'Flashcards with "I know this" and "Still learning" and a progress bar, showing every card every time in the same order (the Step 11 C-lecture-flashcards benchmark).',
      strong:
        'The student sees "6 due today, 3 new" and practises a set ordered by need; a wrong answer returns sooner and a run of right answers spaces it out by days. Progress shows learning against mastered. The professor sees the most-missed questions and each student’s last practice date and mastery. Each student’s state is compact, for example one record per student holding every question’s box and due date.',
      capabilities: ['records: shared questions, perStudent practice state', 'course.roster', 'optional course material search at build time to seed questions'],
      mustNotAssume: ['reminders or notifications', 'AI-written questions at run time', 'course skills (the preview can’t show them)', 'grades'],
    },
    set: 'dev',
    variance: false,
  },
  {
    id: 'D04-staged-case',
    prompt: 'I run case discussions where I reveal the case in parts. Students should decide what they’d do at each part before I show the next one, and at the end I want to see how the class’s decisions played out.',
    tier: 'deep',
    category: 'Staged activity',
    reasoning: ['phases', 'synthesis', 'multi-role'],
    inPattern: false,
    professorGoal: 'Prepare the stages in advance, release them one at a time during class, see the class’s decisions per stage, then show a summary.',
    studentGoal: 'Read the current stage, commit a decision with a reason before the next stage opens, and see the earlier stages and their own decisions.',
    hints: [
      'stages prepared ahead and released by the professor, one at a time',
      'stages not yet released are kept where students can’t read them, not in data every student can read',
      'a decision is locked once its stage has moved on',
      'the student view shows which stage is current and picks up a newly released stage without the student having to guess (there are no push updates)',
      'the professor sees each stage’s decisions as counts, with the reasons',
      'a summary at the end that the professor publishes for students to see',
    ],
    guidance: {
      constraints: [
        'Every student can read every record of a shared collection, so drafts of later stages belong in staffOnly until released.',
        'No push updates: a view sees other people’s writes when it reloads or retries, or by polling within the bridge’s rate limit.',
        'Students can’t read each other’s decisions; a class summary has to be published by staff.',
      ],
      shallow: 'The professor posts stage text into a shared list, all of it visible from the start. Students write free text with no stage or lock. The professor sees a table of replies.',
      strong:
        'Stages are drafted privately and released with one button that says which stage goes out next. The student view says "Stage 2 of 4. Your decision is due before the next stage" and picks up a new stage by itself or with an obvious refresh. Earlier decisions show as locked. The professor sees per stage how many chose each option and why, and publishes a class summary.',
      capabilities: ['records: staffOnly drafts, shared released stages and summary, perStudent decisions', 'course.roster for who has answered'],
      mustNotAssume: ['live push to students', 'students reading classmates’ answers directly', 'timers enforced by the server'],
    },
    set: 'dev',
    variance: false,
  },
  {
    id: 'D05-review-game',
    prompt: 'Make a Jeopardy-style review game I can run on the projector before the midterm. The class plays in teams.',
    tier: 'deep',
    category: 'Classroom game',
    reasoning: ['phases', 'synthesis', 'platform-limits'],
    inPattern: false,
    professorGoal: null,
    studentGoal: null,
    hints: [],
    set: 'holdout',
    sealed: true,
    variance: false,
  },
  {
    id: 'D06-final-grade-calculator',
    prompt: 'Students keep asking me what they need on the final to get an A or a B. Can you make something that works that out for them?',
    tier: 'deep',
    category: 'Grade calculator',
    reasoning: ['platform-limits', 'algorithmic', 'multi-role'],
    inPattern: true,
    professorGoal: null,
    studentGoal: null,
    hints: [],
    set: 'holdout',
    sealed: true,
    variance: false,
  },
  {
    id: 'D07-peer-feedback',
    prompt: 'Students present in groups. I want everyone to give anonymous feedback to the other groups using my rubric, and I need to see who hasn’t done their reviews.',
    tier: 'deep',
    category: 'Peer feedback',
    reasoning: ['multi-role', 'platform-limits', 'synthesis'],
    inPattern: true,
    professorGoal: 'Set up groups and the rubric, see review completion per student, check feedback before it goes out, and release each group’s anonymous feedback to its members.',
    studentGoal: 'Review every other group on the rubric with a comment, never their own group, then read the feedback their group received once it is released.',
    hints: [
      'groups set by the professor, and each student knows their own group',
      'a rubric with criteria and levels the professor defines',
      'students review the other groups and never their own',
      'completion per student, with the roster',
      'feedback reaches each group through a staff release step, because students can’t read each other’s records',
      'presenters never learn who wrote what, and the tool is honest that staff can see who wrote each review',
    ],
    guidance: {
      constraints: [
        'Students write only their own records and read only shared data and what staff recorded about them.',
        'The tool never learns names, and students can’t see the roster, so groups are labels.',
        'Staff views receive the author of every student record, so reviews are anonymous to peers, not to staff.',
      ],
      shallow: 'Students type a group name and a comment. The professor sees a list. Nothing ever reaches the presenters, or the tool claims students can read feedback about them directly.',
      strong:
        'The professor assigns groups from the roster and enters the rubric. Each student sees "Review 3 of 5 groups", their own left out. The professor sees who is missing reviews and per-group averages per criterion, then one release step writes each group’s averages and comments to its members without reviewer names. The tool says staff can see who wrote each review.',
      capabilities: ['course.roster', 'records: staffPerStudent group membership and released feedback, shared rubric and group list, perStudent reviews'],
      mustNotAssume: ['students reading other students’ records', 'names shown to students', 'anonymity from staff enforced by the platform'],
    },
    set: 'dev',
    variance: false,
  },
  {
    id: 'D08-lab-notebook',
    prompt: 'Students keep a lab notebook: an entry for each lab, which my TAs read and either sign off or send back for changes. I want to see where everyone is.',
    tier: 'deep',
    category: 'Review cycle',
    reasoning: ['multi-role', 'longitudinal', 'branching'],
    inPattern: true,
    professorGoal: 'See per student and per lab what is signed off, waiting or sent back, with a queue of entries waiting for the TAs.',
    studentGoal: 'Write an entry per lab, submit it, see the decision and comments, revise and resubmit, and see their history.',
    hints: [
      'entries per lab with draft and submitted states',
      'a review cycle (submitted, sent back, revised, signed off) visible to both roles',
      'comments from the reviewer, and revisions kept or at least marked',
      'a queue of entries waiting for review, oldest first',
      'an overview by student and lab',
      'the review decision is kept apart from the student’s entry, because staff can’t edit a student’s own records',
      'honest that entries are text only, with no attachments',
    ],
    guidance: {
      constraints: [
        'Staff never write a student’s perStudent record, so the review lives in a staffPerStudent record that points at the entry.',
        'The tool can’t tell which TA is signed in.',
        `Entries are plain text within ${KB(STUDIO_RECORD_MAX_BYTES)} a record. No files or photos.`,
        'RosterTable takes at most four columns, so a many-lab overview needs another shape.',
      ],
      shallow: 'Students write entries. Staff see a table with a "Signed" checkbox stored where students can’t see it. No send-back path, and the student never learns the outcome.',
      strong:
        'The student sees each lab’s status as a Badge ("Sent back: add your error analysis") and can revise and resubmit, the earlier version kept. TAs get "Waiting for review: 12", oldest first, and sign off or send back with a comment, with an initials field standing in for the TA identity the tool can’t see. The professor sees completion per lab and can open a student.',
      capabilities: ['course.roster', 'records: perStudent entries and versions, staffPerStudent reviews'],
      mustNotAssume: ['attachments or photos', 'rich text', 'knowing which TA reviewed', 'staff editing a student’s entry'],
    },
    set: 'dev',
    variance: false,
  },
]

export const qualityCase = (id: string): QualityCase | undefined => QUALITY_CASES.find((c) => c.id === id)
