/**
 * The canonical professor requests for studio-generation-quality-v1. Approved in Step
 * 12A.1 (docs/designs/studio/studio-generation-quality.md, section 5).
 *
 * Only `prompt` ever reaches the builder (build.ts takes a string and holds the scripted
 * professor's neutral answer and the synthetic course itself). Goals and hints are
 * for the judge alone: they say what a domain expert would expect, not a checklist, so a
 * different good solution can score as well. Tests check that none of them reaches a
 * model input during a build.
 */

export interface QualityCase {
  id: string
  prompt: string
  category: string
  /** The builder's instructions already describe this kind of workflow ("Patterns that work"). */
  inPattern: boolean
  professorGoal: string
  studentGoal: string
  hints: string[]
  /** Process holdout: its detailed results aren't inspected while tuning Step 12. */
  set: 'dev' | 'holdout'
  /** One of the five cases built five times to measure nondeterminism. */
  variance: boolean
}

export const QUALITY_CASES: readonly QualityCase[] = [
  {
    id: 'Q01-attendance',
    prompt: 'I want to take attendance in my lectures this semester.',
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
    category: 'Phased activity',
    inPattern: false,
    professorGoal: 'Open predictions, then reveal the result.',
    studentGoal: 'Predict, then compare with the class.',
    hints: ['phase control: open, locked, revealed', 'the class distribution shown only after the reveal'],
    set: 'holdout',
    variance: false,
  },
]

export const qualityCase = (id: string): QualityCase | undefined => QUALITY_CASES.find((c) => c.id === id)
