// The tenant and the people in it: institution, department, program, auth users
// and profiles, the course, its three sections, enrollments and section staff.
// Everything downstream takes its ids from what this file returns.

import {
  db, det, up, ok, warn, phase, log, columnExists,
  INSTITUTION_ID, INSTITUTION_NAME, INSTITUTION_SLUG, EMAIL_DOMAIN, DEMO_PASSWORD,
  TERM_START, TERM_END, SEMESTER, TERM_YEAR, TERM_LABEL, isoDate, atTerm, daysAgo,
} from './context'

export interface Person {
  key: string
  first: string
  last: string
  email: string
  role: 'institution_admin' | 'professor' | 'student' | 'course_assistant'
  id: string
  cwid: string
}

function person(
  first: string,
  last: string,
  role: Person['role'],
  localPart?: string,
): Omit<Person, 'id' | 'cwid'> {
  const local = localPart ?? `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '')
  return { key: local, first, last, email: `${local}@${EMAIL_DOMAIN}`, role }
}

// Names are ordinary and varied on purpose: a demo roster full of "Student One"
// reads as a fixture, and a roster of one ethnicity reads as careless.
const STAFF_DEFS = [
  person('Karen', 'Doyle', 'institution_admin', 'admin'),
  person('Elena', 'Vasquez', 'professor'),
  person('Marcus', 'Whitfield', 'professor'),
  person('Aisha', 'Rahman', 'professor'),
  person('Daniel', 'Okafor', 'course_assistant'),
  person('Sofia', 'Almeida', 'course_assistant'),
] as const

const STUDENT_DEFS = [
  // Section A (12) — the section every demo is driven from.
  person('Priya', 'Raman', 'student'),
  person('Jonah', 'Feldman', 'student'),
  person('Mei', 'Ling', 'student'),
  person('Tobias', 'Brandt', 'student'),
  person('Amara', 'Nwosu', 'student'),
  person('Lucas', 'Moretti', 'student'),
  person('Hannah', 'Kessler', 'student'),
  person('Diego', 'Salazar', 'student'),
  person('Yuki', 'Tanaka', 'student'),
  person('Nadia', 'Haddad', 'student'),
  person('Owen', 'Bradley', 'student'),
  person('Zara', 'Mensah', 'student'),
  // Section B (7)
  person('Ethan', 'Caldwell', 'student'),
  person('Rosa', 'Delgado', 'student'),
  person('Arjun', 'Mehta', 'student'),
  person('Claire', 'Boisvert', 'student'),
  person('Samuel', 'Obeng', 'student'),
  person('Ingrid', 'Larsen', 'student'),
  person('Kenji', 'Watanabe', 'student'),
  // Section C (5)
  person('Talia', 'Bergman', 'student'),
  person('Felix', 'Nowak', 'student'),
  person('Imani', 'Roberts', 'student'),
  person('Andres', 'Quintero', 'student'),
  person('Leah', 'Sorensen', 'student'),
] as const

export interface Roster {
  admin: Person
  professors: Person[]
  assistants: Person[]
  students: Person[]
  byKey: Map<string, Person>
}

export interface SectionInfo {
  id: string
  code: 'A' | 'B' | 'C'
  professor: Person
  students: Person[]
  /** Meeting weekdays, 0 = Sunday. Live classes must land on these. */
  meetingDays: number[]
  meetingHour: number
  location: string
}

export interface Campus {
  roster: Roster
  courseId: string
  departmentId: string
  programId: string
  sections: SectionInfo[]
  /** Section A — the one seeded to full depth. */
  main: SectionInfo
}

// ── Auth users ────────────────────────────────────────────────────────

/** Every auth user in the project, keyed by email. One paged sweep beats one
 *  listUsers call per person, and a single 200-row page silently misses users
 *  on any project that has more than that. */
async function loadAuthUsers(): Promise<Map<string, string>> {
  const byEmail = new Map<string, string>()
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    for (const u of data.users) if (u.email) byEmail.set(u.email.toLowerCase(), u.id)
    if (data.users.length < 200) break
  }
  return byEmail
}

async function ensureAuthUser(
  existing: Map<string, string>,
  def: Omit<Person, 'id' | 'cwid'>,
): Promise<string> {
  const found = existing.get(def.email.toLowerCase())
  const name = `${def.first} ${def.last}`
  if (found) {
    const { error } = await db.auth.admin.updateUserById(found, {
      password: DEMO_PASSWORD,
      email_confirm: true,
      app_metadata: { requires_password_set: false },
      user_metadata: { password_set: true, name },
    })
    if (error) throw error
    return found
  }
  const { data, error } = await db.auth.admin.createUser({
    email: def.email,
    password: DEMO_PASSWORD,
    email_confirm: true,
    app_metadata: { requires_password_set: false },
    user_metadata: { password_set: true, name },
  })
  if (error || !data.user) throw error ?? new Error(`createUser returned no user for ${def.email}`)
  return data.user.id
}

// ── Institution / department / program ────────────────────────────────

async function seedInstitution() {
  await up('institutions', [
    {
      id: INSTITUTION_ID,
      name: INSTITUTION_NAME,
      slug: INSTITUTION_SLUG,
      status: 'active',
      timezone: 'America/New_York',
      allow_student_drop: true,
      add_drop_deadline_days: 14,
      settings: { selfUnenroll: { enabled: true, days: 14 } },
    },
  ])
  ok(`institution: ${INSTITUTION_NAME} (${INSTITUTION_SLUG})`)
}

// ── Users ─────────────────────────────────────────────────────────────

async function seedPeople(): Promise<Roster> {
  const existing = await loadAuthUsers()
  const defs = [...STAFF_DEFS, ...STUDENT_DEFS]
  const people: Person[] = []

  for (let i = 0; i < defs.length; i++) {
    const d = defs[i]
    const id = await ensureAuthUser(existing, d)
    // The login page lets a student sign in with an 8-DIGIT campus id instead of
    // an email (resolveCwidToEmail), so the format has to match or that path is
    // undemonstrable. cwid is UNIQUE across the whole profiles table, so derive
    // it from the person rather than their position in the list: reordering the
    // roster then cannot hand someone a number another demo row already holds.
    // The 77 prefix is unused by every real cwid in production.
    const digits = det(`cwid-${d.key}`).replace(/\D/g, '').padEnd(6, '0').slice(0, 6)
    people.push({ ...d, id, cwid: `77${digits}` })
  }

  // `cwid` is in the base schema but absent from some local stacks, and an open
  // SSO branch drops it outright. It is a nice-to-have (it enables the id-based
  // login), never a reason for the whole seed to die — so ask the database
  // whether it has the column instead of assuming.
  const hasCwid = await columnExists('profiles', 'cwid')
  if (!hasCwid) warn('profiles.cwid is missing on this database — seeding without campus ids')

  await up(
    'profiles',
    people.map((p) => ({
      id: p.id,
      email: p.email,
      university_email: p.email,
      first_name: p.first,
      last_name: p.last,
      name: `${p.first} ${p.last}`,
      ...(hasCwid ? { cwid: p.cwid } : {}),
      role: p.role,
      institution_id: INSTITUTION_ID,
      status: 'active',
      onboarding_completed: true,
      // 'accepted' is the admin console's "Onboarding" bucket; staff who are
      // actually teaching must be 'active' or the console shows no active faculty.
      invite_status: 'active',
      invited_at: atTerm(-2),
      invite_accepted_at: atTerm(-1),
      last_login_at: daysAgo(p.role === 'student' ? 1 : 0),
      last_active_at: daysAgo(p.role === 'student' ? 1 : 0),
    })),
  )

  const byKey = new Map(people.map((p) => [p.key, p]))
  const roster: Roster = {
    admin: people.find((p) => p.role === 'institution_admin')!,
    professors: people.filter((p) => p.role === 'professor'),
    assistants: people.filter((p) => p.role === 'course_assistant'),
    students: people.filter((p) => p.role === 'student'),
    byKey,
  }
  ok(
    `${people.length} people: 1 admin, ${roster.professors.length} professors, ` +
      `${roster.assistants.length} assistants, ${roster.students.length} students`,
  )
  return roster
}

// ── Department, program, faculty ──────────────────────────────────────

async function seedDepartment(roster: Roster) {
  const departmentId = det('department')
  const programId = det('program')

  await up('departments', [
    {
      id: departmentId,
      name: 'Computer Science',
      code: 'CS',
      description:
        'Undergraduate and graduate study in computing, spanning systems, theory, ' +
        'machine learning, and human-computer interaction.',
      office_location: 'Halloran Hall 312',
      contact_email: `cs.department@${EMAIL_DOMAIN}`,
      contact_phone: '(201) 555-0142',
      status: 'active',
      institution_id: INSTITUTION_ID,
    },
  ])

  await up('programs', [
    {
      id: programId,
      department_id: departmentId,
      name: 'BS in Computer Science',
      code: 'CS-BS',
      degree_type: 'bachelor',
      description: 'ABET-accredited four-year undergraduate degree in computer science.',
      total_credits: 128,
      duration_semesters: 8,
      director_id: roster.professors[0].id,
      status: 'active',
      institution_id: INSTITUTION_ID,
    },
  ])

  // `position` is a constrained enum in the schema; `title` is free text.
  const titles = ['Associate Professor', 'Professor', 'Assistant Professor']
  const positions = ['associate_professor', 'professor', 'assistant_professor']
  const offices = ['Halloran Hall 418', 'Halloran Hall 402', 'Kidde Building 227']
  const interests = [
    ['Machine Learning', 'Representation Learning', 'Fairness in ML'],
    ['Distributed Systems', 'Applied Statistics', 'Model Serving'],
    ['Natural Language Processing', 'Information Retrieval', 'Human-AI Interaction'],
  ]
  await up(
    'department_faculty',
    roster.professors.map((p, i) => ({
      id: det(`faculty-${p.key}`),
      department_id: departmentId,
      professor_id: p.id,
      title: titles[i],
      position: positions[i],
      employment_type: 'full_time',
      office_location: offices[i],
      office_hours: 'By appointment, or see the booking page',
      office_phone: `(201) 555-01${60 + i}`,
      bio:
        `${p.first} ${p.last} teaches and advises in the Computer Science department, ` +
        `with research in ${interests[i][0].toLowerCase()}.`,
      research_interests: interests[i],
      city: 'Hoboken',
      state: 'NJ',
      country: 'USA',
      is_primary_department: true,
      status: 'active',
      joined_at: atTerm(-52),
      role: 'faculty',
    })),
  )
  ok('department: Computer Science · program: BS in Computer Science')
  return { departmentId, programId }
}

// ── Course and sections ───────────────────────────────────────────────

/** Every toggleable feature, so nothing in the demo is hidden behind a switch. */
export const ALL_FEATURES = [
  'modules', 'announcements', 'grades', 'assignments', 'roadmap', 'quizzes',
  'projects', 'discussions', 'live-classroom', 'challenges', 'intel', 'athena',
  'pre-class-audio', 'enrollment', 'staff', 'settings',
]

const COURSE_CODE = 'CS 340'
const COURSE_TITLE = 'Applied Machine Learning'

function aboutBlocks(professorName: string, sectionCode: string) {
  const doc = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
  return {
    version: 2,
    blocks: [
      {
        id: 'hero-001',
        type: 'hero',
        data: {
          title: COURSE_TITLE,
          subtitle: `${COURSE_CODE} — Build, evaluate, and ship machine learning systems on real data.`,
          semester: TERM_LABEL,
          credits: '3 Credits',
          instructor: `Prof. ${professorName}`,
          ctaText: 'View Syllabus',
          ctaUrl: '',
          bannerSrc: '',
          bannerAlt: '',
          bannerPath: '',
          introVideoUrl: '',
        },
      },
      {
        id: 'text-welcome-001',
        type: 'text',
        data: {
          content: {
            type: 'doc',
            content: [
              { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Welcome to ${COURSE_CODE}-${sectionCode}` }] },
              {
                type: 'paragraph',
                content: [{
                  type: 'text',
                  text:
                    'This course takes you from a raw dataset to a model other people can rely on. ' +
                    'You will write the pipeline yourself: cleaning, feature construction, model selection, ' +
                    'honest evaluation, and the failure analysis that separates a demo from a system.',
                }],
              },
              {
                type: 'paragraph',
                content: [{
                  type: 'text',
                  text:
                    'Work is hands-on. Every week pairs a lecture with a small implementation, and the ' +
                    'semester ends with a team project on a dataset you choose.',
                }],
              },
            ],
          },
        },
      },
      {
        id: 'outcomes-001',
        type: 'learning-outcomes',
        data: {
          title: 'Learning Outcomes',
          outcomes: [
            { id: 'lo-1', text: 'Frame a business or research question as a supervised learning problem', isCore: true },
            { id: 'lo-2', text: 'Build reproducible data pipelines with correct train/validation/test discipline', isCore: true },
            { id: 'lo-3', text: 'Select, tune, and compare models using metrics appropriate to the task', isCore: true },
            { id: 'lo-4', text: 'Diagnose overfitting, leakage, and distribution shift from evidence', isCore: true },
            { id: 'lo-5', text: 'Communicate model behaviour and limitations to a non-technical audience', isCore: true },
            { id: 'lo-6', text: 'Evaluate fairness and deployment risk before a model ships', isCore: false },
          ],
        },
      },
      { id: 'divider-001', type: 'divider', data: {} },
      {
        id: 'table-grading-001',
        type: 'table',
        data: {
          hasHeaderRow: true,
          rows: [
            ['Component', 'Weight', 'Details'],
            ['Homework', '30%', 'Five implementation assignments, lowest score dropped'],
            ['Quizzes', '15%', 'Weekly concept checks, lowest score dropped'],
            ['Midterm', '20%', `In class, week 8 of the ${TERM_LABEL} term`],
            ['Team Project', '25%', 'Teams of three, four graded phases'],
            ['Participation', '10%', 'Live class polls, discussion, and peer review'],
          ],
        },
      },
      {
        id: 'highlight-prereqs-001',
        type: 'highlight-box',
        data: {
          title: 'Prerequisites',
          variant: 'important',
          content: doc(
            'CS 284 (Data Structures) and MA 222 (Probability and Statistics). You should be ' +
            'comfortable writing Python and reading linear algebra notation. No prior ML required.',
          ),
        },
      },
      {
        id: 'callout-tools-001',
        type: 'callout',
        data: {
          title: 'Tools',
          variant: 'info',
          content: doc(
            'Python 3.11, scikit-learn, pandas, and PyTorch. Notebooks run on Colab if you have no GPU. ' +
            'All work is submitted through Scholera.',
          ),
        },
      },
      {
        id: 'faq-001',
        type: 'faq',
        data: {
          title: 'Frequently Asked Questions',
          items: [
            {
              id: 'faq-q1',
              question: 'Can I use an AI assistant on assignments?',
              answer: doc(
                'Yes for understanding and debugging, no for generating the solution you submit. ' +
                'Each assignment states its policy, and you must cite any tool you used.',
              ),
            },
            {
              id: 'faq-q2',
              question: 'What happens if I miss a quiz?',
              answer: doc('Your lowest quiz is dropped, so one miss costs nothing. There are no make-ups.'),
            },
            {
              id: 'faq-q3',
              question: 'Do I need my own GPU?',
              answer: doc('No. Every assignment runs on a laptop CPU in under ten minutes, and Colab covers the project.'),
            },
          ],
        },
      },
    ],
  }
}

function sectionSettings(professorName: string, sectionCode: string, accent: string) {
  return {
    enabledFeatures: ALL_FEATURES,
    sidebarHidden: [],
    features: {
      ai_tutor: true,
      adaptive_quizzes: true,
      ai_quiz_generation: true,
      ai_course_generation: true,
      office_hours_booking: true,
      group_projects: true,
    },
    customization: { accentColor: accent, shortDescription: 'Build and ship ML systems on real data.' },
    about: aboutBlocks(professorName, sectionCode),
    allowTeamWorkspaces: true,
  }
}

async function seedCourse(roster: Roster, departmentId: string): Promise<{ courseId: string; sections: SectionInfo[] }> {
  const courseId = det('course')
  await up('courses', [
    {
      id: courseId,
      department_id: departmentId,
      code: COURSE_CODE,
      title: COURSE_TITLE,
      description:
        'A hands-on introduction to supervised machine learning: data preparation, linear and ' +
        'tree-based models, neural networks, evaluation, and the failure modes that matter in ' +
        'production. Culminates in a team project on a dataset of your choosing.',
      credits: 3,
      level: 'undergraduate',
      prerequisites: ['CS 284', 'MA 222'],
      status: 'active',
      institution_id: INSTITUTION_ID,
    },
  ])

  // Section A meets Mon/Wed, B meets Tue/Thu, C meets Wed/Fri. Live-classroom
  // rooms are anchored to these days so the session list agrees with the syllabus.
  const defs: Array<{
    code: 'A' | 'B' | 'C'
    prof: Person
    days: number[]
    hour: number
    location: string
    accent: string
    count: number
  }> = [
    { code: 'A', prof: roster.professors[0], days: [1, 3], hour: 14, location: 'Babbio 122', accent: '#2563EB', count: 12 },
    { code: 'B', prof: roster.professors[1], days: [2, 4], hour: 16, location: 'Babbio 210', accent: '#7C3AED', count: 7 },
    { code: 'C', prof: roster.professors[2], days: [3, 5], hour: 11, location: 'Burchard 118', accent: '#059669', count: 5 },
  ]

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const sections: SectionInfo[] = []
  let cursor = 0

  for (const d of defs) {
    const id = det(`section-${d.code}`)
    const students = roster.students.slice(cursor, cursor + d.count)
    cursor += d.count

    await up('course_sections', [
      {
        id,
        course_id: courseId,
        professor_id: d.prof.id,
        institution_id: INSTITUTION_ID,
        section_code: d.code,
        semester: SEMESTER,
        year: TERM_YEAR,
        start_date: isoDate(TERM_START.toISOString()),
        end_date: isoDate(TERM_END.toISOString()),
        enrollment_start_date: isoDate(atTerm(-3)),
        enrollment_end_date: isoDate(atTerm(2)),
        max_students: 30,
        status: 'active',
        modality: 'in_person',
        location: d.location,
        schedule: {
          days: d.days.map((n) => dayNames[n]),
          startTime: `${String(d.hour).padStart(2, '0')}:00`,
          endTime: `${String(d.hour + 1).padStart(2, '0')}:20`,
          location: d.location,
        },
        settings: sectionSettings(`${d.prof.first} ${d.prof.last}`, d.code, d.accent),
      },
    ])

    sections.push({
      id,
      code: d.code,
      professor: d.prof,
      students,
      meetingDays: d.days,
      meetingHour: d.hour,
      location: d.location,
    })
  }
  ok(`course ${COURSE_CODE} · sections A (${defs[0].count}), B (${defs[1].count}), C (${defs[2].count})`)
  return { courseId, sections }
}

// ── Enrollments and staff ─────────────────────────────────────────────

async function seedEnrollments(sections: SectionInfo[]) {
  const rows: Record<string, unknown>[] = []
  for (const s of sections) {
    s.students.forEach((st, i) => {
      // One student per section left, which is what a real roster looks like two
      // months in and gives the roster page a non-empty "dropped" filter.
      const dropped = i === s.students.length - 1 && s.code !== 'A'
      rows.push({
        id: det(`enroll-${st.key}-${s.code}`),
        section_id: s.id,
        student_id: st.id,
        status: dropped ? 'dropped' : 'enrolled',
        enrolled_at: atTerm(-1, i % 5),
        dropped_at: dropped ? atTerm(2, 1) : null,
        source: i % 4 === 0 ? 'import' : 'manual',
      })
    })
  }
  await up('enrollments', rows)
  ok(`${rows.length} enrollments`)
}

async function seedStaff(roster: Roster, main: SectionInfo) {
  await up('section_staff', [
    {
      id: det('staff-ta'),
      section_id: main.id,
      staff_id: roster.assistants[0].id,
      role: 'ta',
      status: 'active',
      starts_at: atTerm(0),
      ends_at: TERM_END.toISOString(),
      approved_by: main.professor.id,
    },
    {
      id: det('staff-grader'),
      section_id: main.id,
      staff_id: roster.assistants[1].id,
      role: 'grader',
      status: 'active',
      starts_at: atTerm(1),
      ends_at: TERM_END.toISOString(),
      approved_by: main.professor.id,
    },
  ])

  // A pending request, not yet approved — so the admin "Staff Requests" queue
  // has something in it instead of reading as broken/empty.
  await up('section_staff_requests', [
    {
      id: det('staff-request-1'),
      section_id: main.id,
      requested_by: main.professor.id,
      candidate_email: 'marcus.webb@northcrest.edu',
      candidate_first_name: 'Marcus',
      candidate_last_name: 'Webb',
      requested_role: 'grader',
      starts_at: daysAgo(-3),
      ends_at: TERM_END.toISOString(),
      message: 'Marcus TA\'d this course last spring and is willing to help with Homework 5 grading.',
      status: 'pending',
    },
  ])

  ok('section staff: 1 TA, 1 grader on section A, 1 pending request')
}

// ── Entry point ───────────────────────────────────────────────────────

export async function seedCampus(): Promise<Campus> {
  phase('Tenant, people, course')
  log(`Term: ${TERM_LABEL} — ${isoDate(TERM_START.toISOString())} to ${isoDate(TERM_END.toISOString())}`)

  await seedInstitution()
  const roster = await seedPeople()
  const { departmentId, programId } = await seedDepartment(roster)
  const { courseId, sections } = await seedCourse(roster, departmentId)
  await seedEnrollments(sections)
  const main = sections[0]
  await seedStaff(roster, main)

  if (roster.students.length < 5) warn('fewer than 5 students seeded — check STUDENT_DEFS')

  return { roster, courseId, departmentId, programId, sections, main }
}
