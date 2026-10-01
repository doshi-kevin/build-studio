// Course content: modules and their materials, the skill tree, announcements and
// the reading/commenting around them, the roadmap, ABET outcome alignment, and
// the public catalog pages (reviews, questions, tips).

import {
  db, det, up, ok, phase, warn,
  INSTITUTION_ID, WEEKS_IN, atTerm, daysAgo, rng, TERM_LABEL, NOW,
} from './context'
import type { Campus, SectionInfo } from './roster'
import { WEEKS, SKILL_GROUPS } from './curriculum'
import { makeHandoutPdf, upload, signedUrl } from './files'

const MATERIALS_BUCKET = 'course-materials'

export interface ContentIds {
  /** Section A module ids by week number. */
  moduleByWeek: Map<number, string>
  /** Section A skill ids by skill name. */
  skillIdByName: Map<string, string>
  /** Section A lecture module_item ids by week number. */
  lectureItemByWeek: Map<number, string>
}

// ── Modules and materials ─────────────────────────────────────────────

function handoutSections(week: (typeof WEEKS)[number]) {
  return [
    { heading: 'Overview', body: week.blurb },
    // Joining bullets with spaces collapsed the handout into one run-on
    // paragraph. Keep them as separate lines with a bullet marker.
    ...week.slides.map((s) => ({ heading: s.heading, body: s.bullets.map((b) => `\u2022  ${b}`).join('\n') })),
    {
      heading: 'Before next class',
      body:
        'Re-read the section of the notes covering ' +
        week.skills.join(' and ') +
        '. Bring one question you could not answer from the notes alone.',
    },
  ]
}

async function seedMainModules(main: SectionInfo): Promise<ContentIds> {
  const moduleByWeek = new Map<number, string>()
  const lectureItemByWeek = new Map<number, string>()
  const moduleRows: Record<string, unknown>[] = []
  const itemRows: Record<string, unknown>[] = []
  const extractionJobRows: Record<string, unknown>[] = []

  // A divider splits the term into halves in the professor's module list.
  await up('module_dividers', [
    {
      id: det('divider-1'),
      institution_id: INSTITUTION_ID,
      section_id: main.id,
      title: 'Part I — Classical models',
      position: 0,
    },
    {
      id: det('divider-2'),
      institution_id: INSTITUTION_ID,
      section_id: main.id,
      title: 'Part II — Representation and risk',
      position: 8,
    },
  ])

  let uploaded = 0
  for (const week of WEEKS) {
    const moduleId = det(`module-A-${week.n}`)
    moduleByWeek.set(week.n, moduleId)
    // Matches the handout-upload gate below exactly — a module published one
    // week ahead of its actual content used to publish with a real handout row
    // pointing at no file, which a student could click into but not open.
    const published = week.n <= WEEKS_IN

    moduleRows.push({
      id: moduleId,
      section_id: main.id,
      title: `Week ${week.n} — ${week.topic}`,
      description: week.blurb,
      week_number: week.n,
      position: week.n,
      is_published: published,
      unlock_date: published ? null : atTerm(week.n - 1, 0, 13),
      // NOT NULL DEFAULT '' on prod (local currently allows null — schema
      // drift). Never send an explicit null for this class of column.
      instructor_note:
        week.n === 8
          ? 'Exam is in class. Bring a pen; no notes, no calculator.'
          : '',
      coverage_state: 'active',
      // A module for a week that has not happened yet was still authored in the
      // past — clamp so nothing in the tenant carries a future creation date.
      created_at: week.n - 2 <= WEEKS_IN ? atTerm(Math.max(0, week.n - 2), 0, 9) : daysAgo(2, 9),
    })

    // Lecture handout — a real PDF in the same bucket and path shape the app uses.
    const lectureId = det(`item-A-${week.n}-lecture`)
    lectureItemByWeek.set(week.n, lectureId)
    let content: Record<string, unknown> = { topics: week.skills }
    if (published && week.n <= WEEKS_IN) {
      try {
        const handout = makeHandoutPdf(`Week ${week.n} — ${week.topic}`, handoutSections(week))
        const path = `${main.id}/${moduleId}/week-${String(week.n).padStart(2, '0')}-notes.pdf`
        await upload(MATERIALS_BUCKET, path, handout.buffer, 'application/pdf')
        const extractedAt = atTerm(Math.max(0, week.n - 2), 0, 9)
        const wordCount = handout.pages.reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0)
        content = {
          topics: week.skills,
          filePath: path,
          fileUrl: await signedUrl(MATERIALS_BUCKET, path),
          fileName: `week-${String(week.n).padStart(2, '0')}-notes.pdf`,
          fileType: 'pdf',
          // Written directly from the same generation pass as the PDF above,
          // not a separate re-derivation — the real extraction worker never
          // ran on these files (they were never uploaded through the app),
          // so without this Athena's "no lecture files with extracted text"
          // refusal fires on every quiz-generation request and the primer
          // generator falls back to the week's one-sentence blurb instead of
          // the real lecture content. Same shape the real pipeline writes
          // (ExtractionResultData, src/lib/validations/document-extraction.ts).
          extraction: {
            status: 'completed',
            extractedAt,
            error: null,
            metadata: { pageCount: handout.pages.length, wordCount },
            pages: handout.pages,
          },
        }
        uploaded++

        // A real handout upload runs through the extraction queue — without a
        // row here the admin's /admin/extraction-jobs page (institution_id-
        // scoped, migration 20260807153351) has nothing to show for the 9
        // lectures that actually got extracted. completed_at a few seconds
        // after started_at, same shape the real worker's writeJobCompletion
        // leaves behind — completion never enriches payload, only status/
        // completed_at/error, so payload stays exactly what enqueueExtractionJob
        // itself would have written (src/lib/extraction/enqueue.ts).
        extractionJobRows.push({
          id: det(`extraction-job-${week.n}`),
          kind: 'extract',
          module_item_id: lectureId,
          institution_id: INSTITUTION_ID,
          status: 'completed',
          attempts: 1,
          max_attempts: 3,
          payload: { sectionId: main.id },
          error: null,
          created_at: extractedAt,
          started_at: extractedAt,
          completed_at: new Date(new Date(extractedAt).getTime() + 4_000).toISOString(),
        })
      } catch (err) {
        warn(`week ${week.n} handout upload failed (${(err as Error).message})`)
      }
    }

    itemRows.push({
      id: lectureId,
      module_id: moduleId,
      item_type: 'lecture',
      title: `${week.topic} — lecture notes`,
      description: week.blurb,
      position: 0,
      content,
      is_visible: true,
    })

    itemRows.push({
      id: det(`item-A-${week.n}-note`),
      module_id: moduleId,
      item_type: 'note',
      title: 'Before you come to class',
      position: 1,
      content: {
        body:
          `Skim the notes for week ${week.n}. You do not need to understand all of it — ` +
          `come with the one part that did not land and we will start there.`,
      },
      is_visible: true,
    })

    itemRows.push({
      id: det(`item-A-${week.n}-link`),
      module_id: moduleId,
      item_type: 'link',
      title: `Further reading: ${week.skills[0]}`,
      position: 2,
      content: { url: 'https://scikit-learn.org/stable/user_guide.html' },
      is_visible: true,
    })

    if (week.n % 3 === 0) {
      itemRows.push({
        id: det(`item-A-${week.n}-video`),
        module_id: moduleId,
        item_type: 'video',
        title: `Walkthrough: ${week.topic}`,
        position: 3,
        content: {
          provider: 'youtube',
          videoUrl: 'https://www.youtube.com/watch?v=aircAruvnKk',
          fileUrl: '',
          filePath: '',
          duration: '0',
        },
        is_visible: true,
      })
    }

    if (week.n % 4 === 0) {
      itemRows.push({
        id: det(`item-A-${week.n}-ref`),
        module_id: moduleId,
        item_type: 'reference',
        title: 'Reference implementation',
        position: 4,
        content: {
          referenceType: 'link',
          url: 'https://github.com/scikit-learn/scikit-learn',
          venue: '',
          venueId: '',
          fileUrl: '',
          filePath: '',
        },
        is_visible: true,
      })
    }
  }

  await up('modules', moduleRows)
  await up('module_items', itemRows)
  await up('extraction_jobs', extractionJobRows)
  ok(`section A: ${moduleRows.length} modules, ${itemRows.length} items, ${uploaded} handouts uploaded, ${extractionJobRows.length} extraction jobs`)

  const skillIdByName = await seedSkills(main)
  return { moduleByWeek, skillIdByName, lectureItemByWeek }
}

/** B and C get real but shallow content: three modules of notes and links. */
async function seedSideModules(sections: SectionInfo[]) {
  const moduleRows: Record<string, unknown>[] = []
  const itemRows: Record<string, unknown>[] = []
  for (const s of sections) {
    for (const week of WEEKS.slice(0, 3)) {
      const moduleId = det(`module-${s.code}-${week.n}`)
      moduleRows.push({
        id: moduleId,
        section_id: s.id,
        title: `Week ${week.n} — ${week.topic}`,
        description: week.blurb,
        week_number: week.n,
        position: week.n,
        is_published: true,
        coverage_state: 'active',
        created_at: atTerm(Math.max(0, week.n - 2), 0, 9),
      })
      itemRows.push({
        id: det(`item-${s.code}-${week.n}-note`),
        module_id: moduleId,
        item_type: 'note',
        title: 'Lecture outline',
        position: 0,
        content: { body: week.slides.map((sl) => `${sl.heading}\n${sl.bullets.join('\n')}`).join('\n\n') },
        is_visible: true,
      })
      itemRows.push({
        id: det(`item-${s.code}-${week.n}-link`),
        module_id: moduleId,
        item_type: 'link',
        title: 'Reading',
        position: 1,
        content: { url: 'https://scikit-learn.org/stable/user_guide.html' },
        is_visible: true,
      })
    }
  }
  await up('modules', moduleRows)
  await up('module_items', itemRows)
  ok(`sections B and C: ${moduleRows.length} modules, ${itemRows.length} items`)
}

// ── Skills ────────────────────────────────────────────────────────────

async function seedSkills(main: SectionInfo): Promise<Map<string, string>> {
  const skillIdByName = new Map<string, string>()
  const rows: Record<string, unknown>[] = []
  let position = 0

  for (const group of SKILL_GROUPS) {
    const parentId = det(`skill-A-${group.name}`)
    skillIdByName.set(group.name, parentId)
    rows.push({
      id: parentId,
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      parent_id: null,
      name: group.name,
      info: null,
      source: 'professor',
      position: position++,
      placement_pinned: true,
    })
    for (const child of group.children) {
      const id = det(`skill-A-${child}`)
      skillIdByName.set(child, id)
      rows.push({
        id,
        section_id: main.id,
        institution_id: INSTITUTION_ID,
        parent_id: parentId,
        name: child,
        info: null,
        source: 'ai',
        position: position++,
      })
    }
  }
  await up('skills', rows)

  // The course-level library the section tree was curated from.
  await up(
    'course_skills',
    SKILL_GROUPS.flatMap((g, gi) => [
      {
        id: det(`course-skill-${g.name}`),
        course_id: det('course'),
        institution_id: INSTITUTION_ID,
        parent_id: null,
        name: g.name,
        position: gi * 100,
      },
      ...g.children.map((c, ci) => ({
        id: det(`course-skill-${c}`),
        course_id: det('course'),
        institution_id: INSTITUTION_ID,
        parent_id: det(`course-skill-${g.name}`),
        name: c,
        position: gi * 100 + ci + 1,
      })),
    ]),
  )
  ok(`${rows.length} section skills, ${SKILL_GROUPS.reduce((n, g) => n + g.children.length + 1, 0)} in the course library`)

  // Every AI-sourced skill above is created "now," which is also the review
  // cutoff getUnconfirmedSkillCount() reads — stamp it, mirroring what the
  // professor's own Confirm action (markSkillsReviewed) does, or the tree
  // seeds in permanently flagged as pending the professor's own review.
  const { data: current } = await db
    .from('course_sections')
    .select('settings')
    .eq('id', main.id)
    .single()
  const settings = (current?.settings ?? {}) as Record<string, unknown>
  const topicMastery = (settings.topicMastery ?? {}) as Record<string, unknown>
  const { error: reviewedErr } = await db
    .from('course_sections')
    .update({ settings: { ...settings, topicMastery: { ...topicMastery, skillsReviewedAt: NOW.toISOString() } } })
    .eq('id', main.id)
    .eq('institution_id', INSTITUTION_ID)
  if (reviewedErr) throw reviewedErr

  return skillIdByName
}

// ── Announcements ─────────────────────────────────────────────────────

const doc = (paras: string[]) => ({
  type: 'doc',
  content: paras.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
})

async function seedAnnouncements(campus: Campus) {
  const main = campus.main
  const prof = main.professor
  const ta = campus.roster.assistants[0]
  const enrolled = main.students

  const SIDE_WELCOME: Record<string, string[]> = {
    B: [
      'Welcome to section B. Everything for the course lives here — modules, assignments, and the quizzes when they open.',
      'We meet Tuesdays and Thursdays. Start with the Week 1 module before our first session; the syllabus is on the About page and it answers most of the questions I get in week one.',
      'Homework 1 opens next week and is due a fortnight after that. It is the only piece of assessed work before the midterm, so do not leave it.',
    ],
    C: [
      'Welcome to section C. Course materials are under Modules and I will keep them one week ahead of where we are.',
      'My office hours are Wednesday afternoons and you can book a slot from the calendar rather than emailing me. Bring the code you are stuck on, not a description of it.',
      'Homework 1 opens next week. Read the rubric before you start writing rather than after — most of the marks people lose are for things the rubric asks for explicitly.',
    ],
  }

  const defs: Array<{
    key: string
    title: string
    body: string[]
    daysBack: number
    pinned?: boolean
    important?: boolean
    ack?: boolean
    status?: string
  }> = [
    {
      key: 'welcome',
      title: `Welcome to CS 340 — ${TERM_LABEL}`,
      body: [
        'Welcome. Everything for this course lives here: modules, assignments, quizzes, and the project.',
        'Start with the Week 1 module and the syllabus on the course About page. Office hours open this Thursday and you can book a slot from the calendar.',
      ],
      daysBack: WEEKS_IN * 7 + 2,
      pinned: true,
    },
    {
      key: 'hw1',
      title: 'Homework 1 is open',
      body: [
        'Homework 1 covers framing and the train/test split. It is due end of week 3.',
        'Submit a single notebook. If your notebook does not run top to bottom on a fresh kernel, it will not be graded.',
      ],
      daysBack: WEEKS_IN * 7 - 7,
    },
    {
      key: 'leakage',
      title: 'A note on the leakage question in Quiz 2',
      body: [
        'Quiz 2 question 4 caught most of the class out, so here is the short version.',
        'Fitting the scaler before the split means the test set mean has influenced training. The fix is to fit the scaler inside the pipeline, which refits it per fold.',
      ],
      // A fixed offset, not WEEKS_IN-relative like its siblings above: this
      // announcement is a postmortem on Quiz 2 (assessments.ts, weeksBack: 5,
      // due at daysAgo(35)), so it has to stay pinned to a few days AFTER that
      // fixed due date, not drift with how far into the term the seed happens
      // to run — a WEEKS_IN-relative offset let it land 10 days BEFORE the
      // quiz it's discussing (found by red-team audit).
      daysBack: 35 - 2,
      important: true,
    },
    {
      key: 'project',
      title: 'Team project: form your teams by Friday',
      body: [
        'The team project opens this week. Teams of three. Pick your own or I will assign you to one.',
        'Your first deliverable is a one-page proposal: the decision, the dataset, and the baseline you intend to beat.',
      ],
      daysBack: WEEKS_IN * 7 - 30,
      pinned: true,
    },
    {
      key: 'midterm',
      title: 'Midterm: format and what to revise',
      body: [
        'The midterm is in class in week 8, covering weeks 1 through 7. It is conceptual, closed book, no calculator.',
        'Revise the bias-variance decomposition, the difference between validation and test, and the metrics from week 4. There will be one question asking you to find the leakage in a described setup.',
      ],
      daysBack: Math.max(3, WEEKS_IN * 7 - 44),
      important: true,
      ack: true,
    },
    {
      key: 'officehours',
      title: 'Extra office hours before the project checkpoint',
      body: [
        'I am adding an extra block on Wednesday afternoon this week for project questions only.',
        'Book a slot from the calendar. Bring your baseline numbers, not your architecture diagram.',
      ],
      daysBack: 4,
    },
    {
      key: 'grades',
      title: 'Homework 2 grades are released',
      body: [
        'Homework 2 grades and rubric feedback are now visible under Grades.',
        'The class median was strong. If you disagree with a criterion, open a regrade request within one week rather than emailing me.',
      ],
      daysBack: 2,
    },
    {
      key: 'draft',
      title: 'Final project presentation order (draft)',
      body: ['Draft running order for week 15. Not published yet — I will confirm once the last team registers.'],
      daysBack: 0,
      status: 'draft',
    },
  ]

  const rows = defs.map((d) => ({
    id: det(`ann-${d.key}`),
    section_id: main.id,
    author_id: prof.id,
    title: d.title,
    content: d.body.join('\n\n'),
    rich_content: doc(d.body),
    is_pinned: d.pinned ?? false,
    is_important: d.important ?? false,
    requires_acknowledgement: d.ack ?? false,
    status: d.status ?? 'published',
    visibility: 'all',
    allow_reactions: true,
    allow_comments: true,
    published_at: d.status === 'draft' ? null : daysAgo(d.daysBack, 15),
    created_at: daysAgo(d.daysBack, 15),
    attachments: [],
    links: [],
    linked_items: [],
  }))
  await up('announcements', rows)

  // Reads: older posts are read by nearly everyone, the newest by about half.
  const reads: Record<string, unknown>[] = []
  const acks: string[] = []
  for (const d of defs) {
    if (d.status === 'draft') continue
    const r = rng(`read-${d.key}`)
    for (const st of enrolled) {
      const readRate = d.daysBack > 7 ? 0.95 : 0.55
      if (r() > readRate) continue
      reads.push({
        id: det(`read-${d.key}-${st.key}`),
        announcement_id: det(`ann-${d.key}`),
        student_id: st.id,
        read_at: daysAgo(Math.max(0, d.daysBack - 1), 18),
        acknowledged_at: d.ack ? daysAgo(Math.max(0, d.daysBack - 1), 19) : null,
        via_bulk: false,
      })
      if (d.ack) acks.push(st.key)
    }
  }
  await up('announcement_reads', reads)

  // Three comments and six reactions across ten announcements read as a board
  // nobody engages with. These are the threads a real course board grows: a
  // clarifying question the professor answers, a student answering another
  // student, and one that never got a reply.
  await up('announcement_comments', [
    {
      id: det('ann-comment-1'),
      announcement_id: det('ann-leakage'),
      author_id: enrolled[0].id,
      content: 'This is the clearest explanation of it I have read. Does the same argument apply to target encoding?',
      created_at: daysAgo(WEEKS_IN * 7 - 19, 20),
    },
    {
      id: det('ann-comment-2'),
      announcement_id: det('ann-leakage'),
      author_id: prof.id,
      content: 'Yes, exactly the same. Compute it inside the fold and it is fine; compute it on the full frame and you have leaked.',
      created_at: daysAgo(WEEKS_IN * 7 - 19, 22),
    },
    {
      id: det('ann-comment-3'),
      announcement_id: det('ann-project'),
      author_id: enrolled[3].id,
      content: 'Can a team of two work if we cannot find a third?',
      created_at: daysAgo(WEEKS_IN * 7 - 29, 14),
    },
    {
      id: det('ann-comment-4'),
      announcement_id: det('ann-project'),
      author_id: prof.id,
      content: 'Prefer three, but two is fine if that is where you land. Scope accordingly — I will not expect the same breadth from a pair.',
      created_at: daysAgo(WEEKS_IN * 7 - 29, 17),
    },
    {
      id: det('ann-comment-5'),
      announcement_id: det('ann-project'),
      author_id: enrolled[7].id,
      content: 'We have two and are looking for a third if anyone is unattached. Working on the transit delay dataset.',
      created_at: daysAgo(WEEKS_IN * 7 - 28, 11),
    },
    {
      id: det('ann-comment-6'),
      announcement_id: det('ann-leakage'),
      author_id: enrolled[9].id,
      content: 'Was the quiz question marked on the leakage point specifically, or on the validation/test distinction? I answered the second and still lost it.',
      created_at: daysAgo(WEEKS_IN * 7 - 18, 13),
    },
    {
      id: det('ann-comment-7'),
      announcement_id: det('ann-leakage'),
      author_id: ta.id,
      content: 'The second, and the distinction is the strict one — a validation set you selected on is not a held-out estimate any more. Bring your answer to office hours if you want to walk through it.',
      created_at: daysAgo(WEEKS_IN * 7 - 18, 16),
    },
    {
      id: det('ann-comment-8'),
      announcement_id: det('ann-midterm'),
      author_id: enrolled[2].id,
      content: 'Is the formula sheet the same one that was linked on Quiz 2, or a different one for the exam?',
      created_at: daysAgo(WEEKS_IN * 7 - 46, 9),
    },
    {
      id: det('ann-comment-9'),
      announcement_id: det('ann-midterm'),
      author_id: prof.id,
      content: 'Same sheet, extended with the tree and ensemble material. It is linked on the exam page.',
      created_at: daysAgo(WEEKS_IN * 7 - 46, 12),
    },
    {
      id: det('ann-comment-10'),
      announcement_id: det('ann-midterm'),
      author_id: enrolled[5].id,
      content: 'Thank you. Having it in advance makes a real difference to how I revise.',
      created_at: daysAgo(WEEKS_IN * 7 - 45, 10),
    },
    {
      id: det('ann-comment-11'),
      announcement_id: det('ann-officehours'),
      author_id: enrolled[10].id,
      content: 'Are the extra slots bookable from the calendar like the normal ones, or do we just turn up?',
      created_at: daysAgo(10, 15),
    },
    {
      id: det('ann-comment-12'),
      announcement_id: det('ann-officehours'),
      author_id: prof.id,
      content: 'Bookable, same as always. If they fill up, message me and I will add more — I would rather run an extra hour than have people not come.',
      created_at: daysAgo(10, 18),
    },
    {
      id: det('ann-comment-13'),
      announcement_id: det('ann-grades'),
      author_id: enrolled[6].id,
      content: 'The rubric comments on mine are genuinely useful, thank you for taking the time on those.',
      created_at: daysAgo(7, 14),
    },
    {
      // Deliberately unanswered. A board where every question has a reply
      // within the hour is its own kind of implausible.
      id: det('ann-comment-14'),
      announcement_id: det('ann-hw1'),
      author_id: enrolled[11].id,
      content: 'Is there a page limit on the write-up, or just the notebook requirement?',
      created_at: daysAgo(WEEKS_IN * 7 - 12, 21),
    },
  ])

  // Reactions used to be six rows, all on two announcements, all stamped two
  // days ago regardless of when the announcement went out. Spread them across
  // the board and land each one just after its own announcement was posted.
  //
  // The six (announcement, student, emoji) combinations the PREVIOUS version
  // wrote are all still in here — welcome/🎉/0, grades/👍/1, welcome/🙌/2,
  // grades/🎉/3, welcome/👍/4, grades/🙌/5. That is deliberate: every old row
  // is then matched and updated in place by the natural-key upsert below,
  // rather than left behind as a reaction this script no longer accounts for.
  // A student appears at most once per announcement, which the unique index
  // does not require but a reader would expect.
  const REACTION_PLAN: Array<{ key: string; students: number[]; emoji: string }> = [
    { key: 'welcome', students: [0, 7, 9], emoji: '🎉' },
    { key: 'welcome', students: [2, 3, 10], emoji: '🙌' },
    { key: 'welcome', students: [1, 4], emoji: '👍' },
    { key: 'hw1', students: [5, 8], emoji: '👍' },
    { key: 'leakage', students: [0, 2, 6, 9, 11], emoji: '🙏' },
    { key: 'project', students: [1, 3, 7], emoji: '👍' },
    { key: 'midterm', students: [4, 5, 8, 10], emoji: '🙏' },
    { key: 'officehours', students: [2, 6, 11], emoji: '🙌' },
    { key: 'grades', students: [0, 3, 6, 8], emoji: '🎉' },
    { key: 'grades', students: [1, 9], emoji: '👍' },
    { key: 'grades', students: [5, 10], emoji: '🙌' },
  ]
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const reactions = REACTION_PLAN.flatMap((r) =>
    r.students.map((si) => ({
      id: det(`ann-react-${r.key}-${r.emoji}-${enrolled[si].key}`),
      announcement_id: det(`ann-${r.key}`),
      student_id: enrolled[si].id,
      emoji: r.emoji,
      created_at: daysAgo(Math.max(0, (byKey.get(r.key)?.daysBack ?? 2) - 1), 12 + (si % 8)),
    })),
  )
  // Conflict on the NATURAL key, not on id. The previous version of this seed
  // keyed reactions `ann-react-${student}` — one row per student, on one of two
  // announcements. This version keys them by (announcement, emoji, student),
  // and for at least one row the two schemes produce the same
  // (announcement_id, student_id, emoji) under DIFFERENT ids. Upserting on id
  // would then try to INSERT a row whose natural key already exists and abort
  // the whole run on announcement_reactions_announcement_id_student_id_emoji_key.
  //
  // Conflicting on the natural key updates the row that is really there
  // instead, which is the same reasoning CONTEXT.md records for skill_mastery.
  // Nothing has a foreign key to announcement_reactions.id, so rewriting the id
  // of a matched row is safe and converges it onto the new scheme.
  await up('announcement_reactions', reactions, 'announcement_id,student_id,emoji')

  ok(`${rows.length} announcements, ${reads.length} reads, ${acks.length} acknowledgements, ${reactions.length} reactions`)

  // Side sections get one announcement each so their pages are not empty.
  // Both used to carry the same single sentence, which made the two pages look
  // like one page rendered twice. Each professor writes their own.
  await up(
    'announcements',
    campus.sections.slice(1).map((s) => ({
      id: det(`ann-${s.code}-welcome`),
      section_id: s.id,
      author_id: s.professor.id,
      title: `Welcome to CS 340-${s.code}`,
      content: SIDE_WELCOME[s.code].join('\n\n'),
      rich_content: doc(SIDE_WELCOME[s.code]),
      is_pinned: true,
      status: 'published',
      visibility: 'all',
      allow_reactions: true,
      allow_comments: true,
      published_at: daysAgo(WEEKS_IN * 7 + 1, 15),
      created_at: daysAgo(WEEKS_IN * 7 + 1, 15),
      attachments: [],
      links: [],
      linked_items: [],
    })),
  )
}

// ── Roadmap ───────────────────────────────────────────────────────────

async function seedRoadmap(campus: Campus, ids: ContentIds) {
  const main = campus.main

  // Week N unlocks week N+1. The canvas positions live in the section settings
  // blob the roadmap editor reads; the edges live in their own table.
  const edges: Record<string, unknown>[] = []
  for (let n = 1; n < WEEKS.length; n++) {
    edges.push({
      id: det(`edge-${n}`),
      section_id: main.id,
      from_node_type: 'module',
      from_node_id: ids.moduleByWeek.get(n),
      to_node_type: 'module',
      to_node_id: ids.moduleByWeek.get(n + 1),
      edge_type: 'prerequisite',
      position: n,
    })
  }
  await up('roadmap_edges', edges)

  const positions: Record<string, { x: number; y: number }> = {}
  WEEKS.forEach((w, i) => {
    positions[`mod:${ids.moduleByWeek.get(w.n)}`] = { x: 80 + i * 280, y: 60 }
    const item = ids.lectureItemByWeek.get(w.n)
    if (item) positions[`item:${item}`] = { x: 90 + i * 280, y: 200 }
  })

  const { data: current } = await db
    .from('course_sections')
    .select('settings')
    .eq('id', main.id)
    .single()
  const settings = (current?.settings ?? {}) as Record<string, unknown>
  const { error } = await db
    .from('course_sections')
    .update({ settings: { ...settings, roadmapPositions: positions, roadmapArchived: [] } })
    .eq('id', main.id)
    .eq('institution_id', INSTITUTION_ID)
  if (error) throw error

  // Student progress: everyone has checked off the weeks that have happened,
  // with the usual few stragglers.
  const progress = main.students.map((st, i) => {
    const r = rng(`roadmap-${st.key}`)
    const through = Math.max(1, WEEKS_IN - (i % 4))
    const nodeProgress: Record<string, unknown> = {}
    for (let n = 1; n <= through; n++) {
      const id = ids.moduleByWeek.get(n)!
      nodeProgress[id] = {
        checkedOff: r() > 0.15,
        lastViewedAt: daysAgo((WEEKS_IN - n) * 7 + Math.floor(r() * 4)),
      }
    }
    return {
      id: det(`roadmap-progress-${st.key}`),
      section_id: main.id,
      student_id: st.id,
      progress: { version: 1, nodeProgress, lastAccessedAt: daysAgo(i % 6) },
    }
  })
  await up('roadmap_progress', progress)
  ok(`roadmap: ${edges.length} edges, ${progress.length} student progress records`)
}

// ── Accreditation (ABET) ──────────────────────────────────────────────

const ABET_OUTCOMES: Array<{ code: string; name: string; indicators: string[] }> = [
  {
    code: '1',
    name: 'Analyze a complex computing problem and apply principles of computing to identify solutions',
    indicators: [
      'Decomposes an ill-defined problem into a tractable learning task',
      'Selects an evaluation metric justified by the cost of each error type',
      'Identifies assumptions that would invalidate the chosen approach',
    ],
  },
  {
    code: '2',
    name: 'Design, implement, and evaluate a computing solution to meet a set of requirements',
    indicators: [
      'Implements a reproducible end-to-end data pipeline',
      'Compares candidate models against a defensible baseline',
      'Documents the deployment constraints the design satisfies',
    ],
  },
  {
    code: '3',
    name: 'Communicate effectively in a variety of professional contexts',
    indicators: [
      'Explains model behaviour to a non-technical stakeholder',
      'Reports uncertainty rather than a single point estimate',
    ],
  },
  {
    code: '4',
    name: 'Recognize professional responsibilities and make informed judgments based on legal and ethical principles',
    indicators: [
      'Identifies who is harmed by a false positive and a false negative',
      'Chooses and justifies a fairness criterion',
    ],
  },
]

async function seedAccreditation(campus: Campus, ids: ContentIds) {
  const standardId = det('abet-standard')
  await up('accreditation_standards', [
    {
      id: standardId,
      name: 'ABET Computing Accreditation Commission',
      version: '2026-2027',
      institution_id: INSTITUTION_ID,
      is_active: true,
    },
  ])

  const outcomes: Record<string, unknown>[] = []
  const indicators: Record<string, unknown>[] = []
  ABET_OUTCOMES.forEach((o, oi) => {
    const outcomeId = det(`abet-outcome-${o.code}`)
    outcomes.push({
      id: outcomeId,
      standard_id: standardId,
      code: o.code,
      name: o.name,
      description: null,
      order_index: oi,
    })
    o.indicators.forEach((text, ii) => {
      indicators.push({
        id: det(`abet-indicator-${o.code}-${ii}`),
        outcome_id: outcomeId,
        code: `${o.code}.${ii + 1}`,
        description: text,
        order_index: ii,
      })
    })
  })
  await up('accreditation_outcomes', outcomes)
  await up('accreditation_indicators', indicators)

  // Each indicator is evidenced by a module, at an introduce/reinforce/master level.
  const levels = ['I', 'R', 'M'] as const
  const alignments = indicators.map((ind, i) => {
    const week = WEEKS[(i * 3) % WEEKS.length]
    return {
      id: det(`alignment-${i}`),
      section_id: campus.main.id,
      institution_id: INSTITUTION_ID,
      indicator_id: ind.id as string,
      level: levels[i % 3],
      evidence_source_type: 'module',
      evidence_source_id: ids.moduleByWeek.get(week.n),
      evidence_text: `Week ${week.n} — ${week.topic}`,
      attainment: 62 + ((i * 7) % 33),
      source: i % 3 === 0 ? 'manual' : 'ai',
      status: i % 4 === 0 ? 'draft' : 'approved',
      created_by: campus.main.professor.id,
    }
  })
  await up('course_outcome_alignments', alignments)
  ok(`ABET: ${outcomes.length} outcomes, ${indicators.length} indicators, ${alignments.length} alignments`)
}

// ── Catalog (reviews, questions, tips) ────────────────────────────────

async function seedCatalog(campus: Campus) {
  const courseId = campus.courseId
  const students = campus.main.students
  const prof = campus.main.professor

  const reviews = [
    { i: 0, overall: 5, diff: 4, work: 4, teach: 5, fair: 5, hours: 9, grade: 'A',
      text: 'Hardest course I have taken and the one I use most. The leakage lecture alone was worth it.' },
    { i: 1, overall: 4, diff: 5, work: 5, teach: 4, fair: 4, hours: 12, grade: 'B+',
      text: 'Genuinely good. Homework is heavy — budget a full day each, not an evening.' },
    { i: 2, overall: 5, diff: 4, work: 4, teach: 5, fair: 5, hours: 10, grade: 'A-',
      text: 'The project is the best part. You leave with something you can actually show people.' },
    // Naming a topic ("neural net material"), not a week number: a fixed week
    // number next to a review's own created_at can predate the week it names
    // once enough of the term has passed (found by red-team audit — a review
    // posted at week 6 complained about "weeks 9 and 10").
    { i: 3, overall: 3, diff: 5, work: 5, teach: 3, fair: 4, hours: 14, grade: 'B',
      text: 'Great content, but the pace picks up hard once you hit the neural net material if you have not written one before.' },
    { i: 4, overall: 5, diff: 3, work: 3, teach: 5, fair: 5, hours: 8, grade: 'A',
      text: 'Office hours are worth going to even when you are not stuck.' },
  ]
  await up(
    'course_reviews',
    reviews.map((r) => ({
      id: det(`review-${r.i}`),
      course_id: courseId,
      author_id: students[r.i].id,
      rating_overall: r.overall,
      rating_difficulty: r.diff,
      rating_workload: r.work,
      rating_teaching: r.teach,
      rating_grading_fairness: r.fair,
      review_text: r.text,
      would_take_again: r.overall >= 4,
      grade_received: r.grade,
      hours_per_week: r.hours,
      is_anonymous: r.i === 3,
      status: 'active',
      created_at: daysAgo(30 - r.i * 3),
    })),
  )

  const qas = [
    { q: 'How much Python do I need before taking this?',
      body: 'I have only taken intro CS — no numpy or pandas yet. Trying to work out whether to take this now or wait a semester and pick those up first.',
      a: 'Enough to write a function, use a dictionary, and read a stack trace. We cover pandas and scikit-learn from scratch.' },
    { q: 'Is the midterm curved?',
      body: 'Heard from a friend who took it last year that the average was pretty low. Wondering if grades get adjusted after or if the raw score is final.',
      a: 'No curve, but your lowest homework and your lowest quiz are both dropped, which does most of the same work.' },
    { q: 'Can I use my own dataset for the project?',
      body: 'I have access to a dataset from a research lab I work in and would rather use that than the provided one — does it need instructor approval first?',
      a: 'Yes, and it is encouraged. It needs to be legally yours to use and have at least a few thousand labelled rows.' },
  ]
  await up(
    'course_questions',
    qas.map((qa, i) => ({
      id: det(`question-${i}`),
      course_id: courseId,
      author_id: students[i + 2].id,
      title: qa.q,
      body: qa.body,
      is_anonymous: i === 2,
      status: 'active',
      created_at: daysAgo(40 - i * 5),
    })),
  )
  await up(
    'course_answers',
    qas.map((qa, i) => ({
      id: det(`answer-${i}`),
      question_id: det(`question-${i}`),
      author_id: i === 1 ? prof.id : students[i].id,
      body: qa.a,
      is_anonymous: false,
      is_accepted: true,
      status: 'active',
      created_at: daysAgo(39 - i * 5),
    })),
  )

  const tips = [
    { cat: 'study_advice', text: 'Do the reading before class, not after. The lecture assumes you have seen the words once.' },
    { cat: 'time_management', text: 'Start homework the day it opens. The last question always takes longer than you think.' },
    { cat: 'general', text: 'Write your baseline before you write your model. You will need it for the report anyway.' },
    { cat: 'exam_tips', text: 'The midterm asks you to find the leakage in a described setup. Practise that specifically.' },
    { cat: 'resources', text: 'The scikit-learn user guide is better than most textbooks for this material. It is free.' },
  ]
  await up(
    'course_tips',
    tips.map((t, i) => ({
      id: det(`tip-${i}`),
      course_id: courseId,
      author_id: students[i].id,
      category: t.cat,
      content: t.text,
      is_anonymous: i === 4,
      status: 'active',
      created_at: daysAgo(35 - i * 4),
    })),
  )
  await up(
    'course_tip_votes',
    students.slice(0, 9).map((st, i) => ({
      id: det(`tip-vote-${st.key}`),
      tip_id: det(`tip-${i % tips.length}`),
      user_id: st.id,
      created_at: daysAgo(20 - i),
    })),
  )

  await up('course_professor_insights', [
    {
      id: det('prof-insight-1'),
      course_id: courseId,
      professor_id: prof.id,
      author_id: students[0].id,
      rating_teaching: 5,
      rating_approachability: 5,
      rating_clarity: 4,
      insight_text:
        'Explains the why before the how, which makes the hard weeks survivable. Answers questions in office hours without making you feel stupid for asking.',
      is_anonymous: false,
      status: 'active',
      created_at: daysAgo(18),
    },
    {
      id: det('prof-insight-2'),
      course_id: courseId,
      professor_id: prof.id,
      author_id: students[5].id,
      rating_teaching: 4,
      rating_approachability: 4,
      rating_clarity: 5,
      insight_text: 'Moves fast in lecture but the notes are complete, so you can catch up. Go to office hours early in the term.',
      is_anonymous: true,
      status: 'active',
      created_at: daysAgo(11),
    },
  ])

  ok(`catalog: ${reviews.length} reviews, ${qas.length} Q&A pairs, ${tips.length} tips, 2 professor insights`)
}

// ── Entry point ───────────────────────────────────────────────────────

export async function seedContent(campus: Campus): Promise<ContentIds> {
  phase('Modules, skills, announcements, roadmap, accreditation')
  const ids = await seedMainModules(campus.main)
  await seedSideModules(campus.sections.slice(1))
  await seedAnnouncements(campus)
  await seedRoadmap(campus, ids)
  await seedAccreditation(campus, ids)
  await seedCatalog(campus)
  return ids
}
