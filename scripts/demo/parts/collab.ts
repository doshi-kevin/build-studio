// Everything social: the team project and its workspace, course discussions,
// direct messages, challenges and badges, certificates, office hours, bookings,
// and student calendars.

import {
  db, det, up, ok, phase, pick,
  INSTITUTION_ID, WEEKS_IN, daysAgo, isoDate, rng, NOW, onWeekday,
} from './context'
import type { Campus, Person } from './roster'
import type { Assessments } from './assessments'

export interface Collab {
  projectId: string
  teamIds: string[]
  teamMembers: Map<string, Person[]>
}

// ── Team project ──────────────────────────────────────────────────────

const TEAMS = [
  {
    key: 'readmit',
    name: 'Readmit Radar',
    idea: 'Predicting 30-day hospital readmission from discharge records',
    progress: 0.85,
  },
  {
    key: 'transit',
    name: 'Transit Signal',
    idea: 'Forecasting bus arrival delay from GPS traces and weather',
    progress: 0.7,
  },
  {
    key: 'shelf',
    name: 'Shelf Life',
    idea: 'Estimating grocery spoilage risk to cut waste in a campus dining hall',
    progress: 0.55,
  },
  {
    key: 'triage',
    name: 'Ticket Triage',
    idea: 'Routing IT helpdesk tickets to the right queue from free text',
    progress: 0.4,
  },
]

// Real 3Blue1Brown neural-network videos — publicly stable, on-topic for the
// course, and unlikely to ever 404 mid-demo. One per team, not a shared link:
// distinct video content is exactly the "identical across teams" bug this
// seed keeps having to fix.
const TEAM_WALKTHROUGH_VIDEOS: Record<string, string> = {
  readmit: 'https://www.youtube.com/watch?v=aircAruvnKk',
  transit: 'https://www.youtube.com/watch?v=IHZwWFHWa-w',
  shelf: 'https://www.youtube.com/watch?v=Ilg3gGewQ5U',
  triage: 'https://www.youtube.com/watch?v=tIeHLnjs5U8',
}

// One chat per team, each tied to that team's own dataset — sharing one script
// across teams (with only the speaker swapped) put a readmission-specific
// finding verbatim into the ticket-routing team's chat.
//
// `ch: 'data'` routes a message to the team's second channel, which existed
// from the start and had never had a single message in it — four teams each
// showing an empty channel next to a populated one read as a half-built
// feature. The split is the obvious one: coordination in general, anything
// about the dataset itself in data.
const TEAM_CHATS: Record<string, Array<{ by: number; text: string; back: number; ch?: 'data' }>> = {
  readmit: [
    { by: 0, text: 'Team is set. I will start the plan doc tonight and drop it here when it is readable.', back: 30 },
    { by: 2, text: 'Works for me. I can take the data pull if someone else wants to own the write-up.', back: 30 },
    { by: 1, text: 'I will take the write-up. Sunday evenings are my only reliable block, so expect updates then.', back: 29 },
    { by: 0, text: 'Plan doc is up. I put our baseline numbers at the top so we stop arguing about them.', back: 24 },
    { by: 2, text: 'Pulled the admissions extract — 41k rows, 18 months, one row per admission.', back: 24, ch: 'data' },
    { by: 2, text: 'Readmission within 30 days runs at 14.2%, so that is the base rate to beat.', back: 23, ch: 'data' },
    { by: 1, text: 'Discharge disposition has 11% missing and it is not missing at random — almost all of them are transfers.', back: 23, ch: 'data' },
    { by: 0, text: 'Treat transfer as its own level rather than imputing then. Losing the distinction would be worse.', back: 23, ch: 'data' },
    { by: 1, text: 'The status field is definitely leaking. It gets set after the outcome, I checked the audit log.', back: 22 },
    { by: 2, text: 'So we drop it? That was our strongest feature by a mile.', back: 22 },
    { by: 1, text: 'That is exactly why it was the strongest feature.', back: 21 },
    { by: 0, text: 'Dropping it. Score falls from 0.94 to 0.71 AUC and 0.71 is the real number.', back: 20 },
    { by: 2, text: 'Still beats the baseline at 0.58, so we are fine. I will write it up as a finding rather than a setback.', back: 20 },
    { by: 1, text: 'Split is temporal now — first 14 months train, last 4 test. Random was giving us another 0.04 we had not earned.', back: 18, ch: 'data' },
    { by: 0, text: 'Agreed. Predicting backwards is not a thing we get to do in deployment.', back: 18, ch: 'data' },
    { by: 2, text: 'Comorbidity count and prior admissions are carrying most of the signal now. Both are known at discharge, so no leak.', back: 16, ch: 'data' },
    { by: 1, text: 'Phase 2 draft is in the doc. Someone read the limitations section and tell me if it is too apologetic.', back: 13 },
    { by: 0, text: 'It is about right. Better apologetic than overclaiming, and we have the leak story to justify the tone.', back: 12 },
    { by: 2, text: 'Rebuilt the notebook from a clean checkout to be sure it runs. One hardcoded path, now fixed.', back: 10 },
    { by: 0, text: 'Office hours Thursday to sanity check the split before we submit phase 2.', back: 6 },
    { by: 1, text: 'I can make Thursday. Adding it to the availability grid.', back: 5 },
    { by: 2, text: 'Submitted. The honest number held up in office hours, which was the part I was worried about.', back: 3 },
  ],
  transit: [
    { by: 0, text: 'Team formed. I will sketch the plan doc — shout if you have a strong view on the target.', back: 30 },
    { by: 1, text: 'Delay in minutes rather than a late/on-time flag? Throwing away the magnitude feels wasteful.', back: 30 },
    { by: 2, text: 'Agreed, regression. We can always threshold it afterwards if we want a classifier view.', back: 29 },
    { by: 0, text: 'Pulled three months of GPS pings — plan doc has the baseline (predicted delay = historical average for that route/hour) up top.', back: 24 },
    { by: 2, text: '2.1M pings, 40 routes, one row per stop arrival after I aggregated. Raw file is 900MB so I am not committing it.', back: 24, ch: 'data' },
    { by: 1, text: 'About 3% of arrivals have a negative dwell time, which should not be physically possible.', back: 23, ch: 'data' },
    { by: 2, text: 'Clock skew between the vehicle and the stop sensor. Dropping those rows, it is under 3% and not concentrated on any route.', back: 23, ch: 'data' },
    { by: 1, text: 'Weather join is messier than I hoped. Half the GPS timestamps have no station reading within 10 minutes.', back: 22 },
    { by: 2, text: 'Can we just round to the nearest hour instead of exact match?', back: 22 },
    { by: 1, text: 'Tried that. It fixes most of the missing rows, but rain intensity moves fast enough that hourly flattens our best feature.', back: 21 },
    { by: 0, text: 'Keep hourly for phase 2 and note it as a limitation. Baseline first, precision later.', back: 20 },
    { by: 2, text: 'Baseline is 4.1 min MAE. Model gets to 2.6 with just hour-of-day and precipitation, so already worth reporting.', back: 20 },
    { by: 1, text: 'Checked the row count before and after the weather join — we lose 6%, all from one station that went offline in March.', back: 18, ch: 'data' },
    { by: 0, text: 'Good. That is exactly the check that bit the other teams.', back: 18, ch: 'data' },
    { by: 2, text: 'Rush hour and off-peak behave completely differently. Considering a separate model per regime rather than an hour feature.', back: 16, ch: 'data' },
    { by: 1, text: 'Try the interaction term first — cheaper than maintaining two models and it might get most of the way.', back: 16, ch: 'data' },
    { by: 2, text: 'Interaction got us to 2.4. Not worth splitting the model for the rest.', back: 14, ch: 'data' },
    { by: 0, text: 'Phase 2 draft is up. I led with the MAE against the baseline rather than the model description.', back: 13 },
    { by: 1, text: 'Reads well. The limitations paragraph on hourly weather is doing real work.', back: 12 },
    { by: 0, text: 'Office hours Thursday to check whether route_id should be categorical or bucketed by corridor.', back: 6 },
    { by: 1, text: 'I will bring the per-route counts so we can see which ones have too little data to split reliably.', back: 5 },
    { by: 2, text: 'Corridor bucketing it is — eight routes had under 200 arrivals each and were just adding noise.', back: 3 },
  ],
  shelf: [
    { by: 0, text: 'Team set. I will take the plan doc, and I would rather we agree the target before anyone touches a model.', back: 30 },
    { by: 1, text: '"Will this unit be discarded before it sells" as a binary, predicted at delivery?', back: 30 },
    { by: 2, text: 'That works and it matches what the ordering team would actually act on.', back: 29 },
    { by: 0, text: 'Plan doc is up — baseline is just days-since-delivery, no product-specific curve yet.', back: 24 },
    { by: 2, text: 'Inventory extract is in: 380k unit-level rows across 2,100 SKUs, 14 months.', back: 24, ch: 'data' },
    { by: 2, text: 'Discard rate overall is 6.8%, but it ranges from under 1% on shelf-stable to 19% on soft fruit.', back: 23, ch: 'data' },
    { by: 1, text: 'Produce and dairy decay on completely different curves though. Lumping them together flattens the signal.', back: 22 },
    { by: 2, text: 'So split by category and fit separately?', back: 22 },
    { by: 1, text: 'At least category-level. Might need sub-category for produce specifically.', back: 21 },
    { by: 0, text: 'Category-level for phase 2, sub-category as a stretch goal if we have time.', back: 20 },
    { by: 2, text: 'Category-split baseline: 61% precision on "discard within 2 days." Better than I expected.', back: 20 },
    { by: 1, text: 'Storage temperature is only recorded for 40% of units. Is a mostly-missing column worth keeping?', back: 18, ch: 'data' },
    { by: 0, text: 'Keep it with a missing indicator. If it is recorded for the chilled goods only, the missingness itself is a feature.', back: 18, ch: 'data' },
    { by: 1, text: 'That is exactly what it is. Missing means ambient, which we can now say explicitly.', back: 17, ch: 'data' },
    { by: 2, text: 'Seasonality is strong on produce — summer discard is nearly double winter. Added month as a cyclical feature.', back: 15, ch: 'data' },
    { by: 0, text: 'Make sure the split respects that, otherwise we train on summer and test on summer and learn nothing.', back: 15, ch: 'data' },
    { by: 1, text: 'Phase 2 write-up is drafted. Precision is up to 68% at category level.', back: 13 },
    { by: 2, text: 'Worth saying in the doc that sub-category did not help — we tried it and it overfit the low-volume SKUs.', back: 12 },
    { by: 0, text: 'Office hours Thursday — want a second opinion on whether we are leaking the discard label through the reorder-flag field.', back: 6 },
    { by: 1, text: 'Good catch, I will pull the column definitions before then.', back: 5 },
    { by: 1, text: 'Column definitions confirm it: reorder flag is set by the same nightly job that writes the discard. It is a leak.', back: 4, ch: 'data' },
    { by: 0, text: 'Dropped. Precision falls to 63% and that is the number we report.', back: 3 },
  ],
  triage: [
    { by: 0, text: 'Team is together. Target is the queue a ticket should land in, so this is multiclass rather than binary.', back: 30 },
    { by: 2, text: 'How many queues? If it is a long tail we will need to think about the rare ones.', back: 30 },
    { by: 1, text: 'Eleven, but the top four are 80% of volume. The tail is going to be the hard part.', back: 29 },
    { by: 0, text: 'Plan doc is up. Baseline is keyword match against queue names, nothing fancy.', back: 24 },
    { by: 2, text: 'Ticket export loaded: 62k tickets, 11 queues, subject plus body plus the submitter metadata.', back: 24, ch: 'data' },
    { by: 2, text: 'Two of the eleven queues have under 300 tickets each. Macro F1 is going to be brutal on those.', back: 23, ch: 'data' },
    { by: 1, text: 'Report macro anyway. Weighted would hide exactly the failure we care about.', back: 23, ch: 'data' },
    { by: 1, text: 'The "urgent" flag is basically useless as a feature. It is set by the submitter, not us, and half of them mark everything urgent.', back: 22 },
    { by: 2, text: 'Drop it entirely or keep it as a weak signal?', back: 22 },
    { by: 1, text: 'Drop it. Checked historical resolution times, no real correlation with actual priority.', back: 21 },
    { by: 0, text: 'Fine by me. Keyword baseline alone gets us to 68% correct queue on the held-out set.', back: 20 },
    { by: 2, text: 'TF-IDF plus logistic regression pushes that to 81%. Simple, but it is a real jump.', back: 20 },
    { by: 1, text: 'About 4% of tickets are duplicates — same body, submitted twice. They need to be on the same side of the split.', back: 18, ch: 'data' },
    { by: 2, text: 'Grouped the split on body hash. Test score drops a point, which means we were leaking before.', back: 17, ch: 'data' },
    { by: 0, text: 'That point is the most honest point we have gained all term.', back: 17, ch: 'data' },
    { by: 1, text: 'Tried character n-grams alongside word-level. Helps the rare queues specifically, macro F1 up 3 points.', back: 15, ch: 'data' },
    { by: 0, text: 'Phase 2 draft is in the doc. I led with the macro number and put the weighted one in a footnote.', back: 13 },
    { by: 2, text: 'Right call. The confusion matrix on the two small queues is the most useful plot we have.', back: 12 },
    { by: 0, text: 'Office hours Thursday to check whether we can use the subject line — some tickets have the requester’s name in it.', back: 6 },
    { by: 1, text: 'I will bring the anonymization question, good to sort before we write it up.', back: 5 },
    { by: 1, text: 'Cleared: strip anything matching the submitter name field before vectorising. Costs us almost nothing in score.', back: 4, ch: 'data' },
    { by: 0, text: 'Submitted. Macro F1 of 0.74, which we can defend line by line.', back: 3 },
  ],
}

// Same bug again, one level down: the project-plan doc's "Open questions" used
// one shared list naming the readmission team's own leaking-field concern on
// every team's plan doc, dataset-appropriate or not.
const TEAM_OPEN_QUESTIONS: Record<string, string[]> = {
  readmit: ['Is the target leaking through the status field?', 'How do we handle the 8% of rows with no outcome recorded?'],
  transit: ['Does hourly weather granularity lose too much signal on fast-moving storms?', 'Should delay be predicted per-stop or per-route?'],
  shelf: ['Is the discard label leaking through the reorder-flag field?', 'Do we need sub-category splits for produce specifically?'],
  triage: ['Are we allowed to use the ticket subject line, given some include the requester’s name?', 'Should the "urgent" self-report flag be dropped entirely?'],
}

// Same team-specific-content bug as TEAM_CHATS, one level up: a professor
// phase comment shared across all four teams named the readmission finding
// on every team's own project, including the three that never had it.
const TEAM_PHASE_COMMENTS: Record<string, string> = {
  readmit: 'Good catch on the leaking field, and the right call to drop it. Make sure the report leads with that rather than burying it in an appendix.',
  transit: 'The hourly-weather tradeoff is the right call for now — just make sure the limitations section names it explicitly rather than leaving it implicit.',
  shelf: 'Category-level splitting was the right instinct. Chase down the reorder-flag leak before phase 3, it will undercut your precision number otherwise.',
  triage: 'Good instinct dropping the urgent flag — a self-reported label with no correlation to outcome was never going to help. The TF-IDF jump is a solid result to lead with.',
}

/** Negative `back` is in the future — one upcoming meeting per team so the
 *  panel shows a scheduled state as well as a history. */
const TEAM_MEETINGS = [
  { title: 'Kickoff — scope and who owns what', back: 29 },
  { title: 'Baseline review before phase 2', back: 19 },
  { title: 'Phase 2 walkthrough dry run', back: 7 },
  { title: 'Phase 3 planning', back: -4 },
]

// `week` is the week the phase is DUE; each runs from two weeks before that.
// Spaced so one phase is always in flight at the current week — the earlier
// schedule left a two-week hole across today, so mid-semester the project had
// nothing running.
const PHASES = [
  { key: 'proposal', title: 'Proposal', desc: 'The decision, the dataset, and the baseline you intend to beat. One page.', week: 3 },
  { key: 'data', title: 'Data and baseline', desc: 'A reproducible split and a working baseline with an honest number.', week: 6 },
  { key: 'model', title: 'Model and evaluation', desc: 'Candidate models compared on the same split, with error analysis.', week: 10 },
  { key: 'final', title: 'Report and presentation', desc: 'Twelve-minute presentation and a written report.', week: 14 },
]

async function seedProject(campus: Campus, grades: Assessments): Promise<Collab> {
  const main = campus.main
  const prof = main.professor
  const projectId = det('project')

  await up('projects', [
    {
      id: projectId,
      section_id: main.id,
      created_by: prof.id,
      title: 'Semester Project — Ship a model someone could rely on',
      description:
        'Teams of three take a dataset from raw to a defensible model. You are graded on the honesty of the evaluation, not the sophistication of the architecture.',
      guidelines:
        'Pick a decision, not a dataset. Build a split you can defend. Beat a real baseline. Then tell us where your model fails and who that hurts. Four graded phases; the final phase includes a presentation in week 15.',
      status: 'active',
      visibility: 'course',
      max_team_size: 3,
      tags: ['machine-learning', 'team', 'capstone'],
      showcase_enabled: true,
      showcase_description: 'Selected projects are published to the course showcase at the end of term.',
      allow_team_workspace: true,
      due_date: isoDate(daysAgo(-((15 - WEEKS_IN) * 7))),
      created_at: daysAgo(WEEKS_IN * 7 - 28, 10),
      settings: {},
    },
  ])

  // Master phases and the graded items hanging off them.
  await up(
    'project_master_phases',
    PHASES.map((p, i) => ({
      id: det(`master-phase-${p.key}`),
      project_id: projectId,
      institution_id: INSTITUTION_ID,
      name: p.title,
      position: i,
      start_date: isoDate(daysAgo((WEEKS_IN - p.week + 2) * 7)),
      end_date: isoDate(daysAgo((WEEKS_IN - p.week) * 7)),
    })),
  )

  const weights = [15, 25, 35, 25]
  await up(
    'project_phase_items',
    PHASES.map((p, i) => ({
      id: det(`phase-item-${p.key}`),
      phase_id: det(`master-phase-${p.key}`),
      project_id: projectId,
      institution_id: INSTITUTION_ID,
      item_type: 'manual',
      assignment_id: null,
      quiz_id: null,
      position: i,
      weight: weights[i],
      grain: 'team',
      scoring_mode: 'numeric',
      manual_title: `${p.title} deliverable`,
      manual_max: 100,
    })),
  )

  const teamIds: string[] = []
  const teamMembers = new Map<string, Person[]>()
  const teamRows: Record<string, unknown>[] = []
  const channelRows: Record<string, unknown>[] = []
  const memberRows: Record<string, unknown>[] = []
  const phaseRows: Record<string, unknown>[] = []
  const itemRows: Record<string, unknown>[] = []
  const docRows: Record<string, unknown>[] = []
  const messageRows: Record<string, unknown>[] = []
  const scoreRows: Record<string, unknown>[] = []
  const gradeRows: Record<string, unknown>[] = []
  const availRows: Record<string, unknown>[] = []
  const meetingRows: Record<string, unknown>[] = []
  const videoRows: Record<string, unknown>[] = []
  const commentRows: Record<string, unknown>[] = []
  /** Default channel id -> team formation date, so the join-system-messages
   *  backdate below (after project_members) can find each team's channel. */
  const defaultChannelFormedAt = new Map<string, string>()

  TEAMS.forEach((t, ti) => {
    const teamId = det(`team-${t.key}`)
    teamIds.push(teamId)
    const members = main.students.slice(ti * 3, ti * 3 + 3)
    teamMembers.set(t.key, members)

    // The two teams with a released project_grades row (below) have actually
    // turned something in; the other two are visibly behind (lower `progress`,
    // no released grade yet) — 'draft', not 'submitted', so the Teams tab
    // doesn't claim a team finished before its own workspace shows it did.
    const hasReleasedGrade = ti < 2
    teamRows.push({
      id: teamId,
      project_id: projectId,
      created_by: members[0].id,
      name: t.name,
      description: t.idea,
      status: 'active',
      workspace_enabled: true,
      created_at: daysAgo(WEEKS_IN * 7 - 30, 14),
      submission: {
        title: t.name,
        tagline: t.idea,
        description: `${t.idea}. Baseline established; data and evaluation phases are graded.`,
        status: hasReleasedGrade ? 'submitted' : 'draft',
        ...(hasReleasedGrade ? { submitted_at: daysAgo(7, 15) } : {}),
      },
    })

    // The default chat channel must exist before members are added: the
    // project_members trigger writes its "joined" system message into it.
    const defaultChannelId = det(`team-channel-${t.key}`)
    const teamFormedAt = daysAgo(WEEKS_IN * 7 - 30, 14)
    defaultChannelFormedAt.set(defaultChannelId, teamFormedAt)
    channelRows.push({
      id: defaultChannelId,
      team_id: teamId,
      name: 'general',
      created_by: members[0].id,
      is_default: true,
      position: 0,
      created_at: teamFormedAt,
    })
    channelRows.push({
      id: det(`team-channel-${t.key}-data`),
      team_id: teamId,
      name: 'data',
      created_by: members[1].id,
      is_default: false,
      position: 1,
      created_at: daysAgo(WEEKS_IN * 7 - 25, 11),
    })

    members.forEach((m, mi) => {
      memberRows.push({
        id: det(`member-${t.key}-${m.key}`),
        project_id: projectId,
        user_id: m.id,
        team_id: teamId,
        role: mi === 0 ? 'owner' : 'member',
        contribution_summary:
          mi === 0 ? 'Pipeline and evaluation' : mi === 1 ? 'Feature engineering and EDA' : 'Modelling and write-up',
        joined_at: daysAgo(WEEKS_IN * 7 - 30 + mi, 15),
      })
      // A couple of slots each for the team-availability grid.
      for (let d = 0; d < 2; d++) {
        availRows.push({
          id: det(`avail-${t.key}-${m.key}-${d}`),
          team_id: teamId,
          user_id: m.id,
          slot_start: daysAgo(-(d + 1), 18 + mi),
        })
      }
    })

    // Per-team phase progress, ahead or behind depending on the team.
    PHASES.forEach((p, pi) => {
      // A phase can only be complete if its due date has actually passed. Team
      // progress alone marked phases "Completed" with dates weeks in the future.
      const inThePast = p.week <= WEEKS_IN
      const done = inThePast && pi / PHASES.length < t.progress
      const current = !done && p.week - 2 <= WEEKS_IN && (pi - 1) / PHASES.length < t.progress
      phaseRows.push({
        id: det(`phase-${t.key}-${p.key}`),
        project_id: projectId,
        team_id: teamId,
        title: p.title,
        description: p.desc,
        status: done ? 'completed' : current ? 'in_progress' : 'not_started',
        position: pi,
        start_date: isoDate(daysAgo((WEEKS_IN - p.week + 2) * 7)),
        due_date: isoDate(daysAgo((WEEKS_IN - p.week) * 7)),
        completed_at: done ? daysAgo(Math.max(1, (WEEKS_IN - p.week) * 7), 20) : null,
        assigned_to: members.slice(0, 2).map((m) => m.id),
      })

      const checklist = [
        'Draft written',
        'Reviewed by the whole team',
        'Submitted',
      ]
      checklist.forEach((title, ci) => {
        itemRows.push({
          id: det(`phase-item-check-${t.key}-${p.key}-${ci}`),
          phase_id: det(`phase-${t.key}-${p.key}`),
          title,
          is_completed: done || (current && ci === 0),
          position: ci,
          completed_by: done || (current && ci === 0) ? members[ci % 3].id : null,
          completed_at: done ? daysAgo(Math.max(1, (WEEKS_IN - p.week) * 7 + 1), 18) : null,
          created_by: members[0].id,
        })
      })

      // Graded phases get a score consistent with how far along the team is.
      if (done) {
        const base = 72 + t.progress * 22
        const earned = Math.round(base + (rng(`score-${t.key}-${p.key}`)() - 0.5) * 8)
        scoreRows.push({
          id: det(`item-score-${t.key}-${p.key}`),
          phase_item_id: det(`phase-item-${p.key}`),
          project_id: projectId,
          institution_id: INSTITUTION_ID,
          team_id: teamId,
          student_id: null,
          earned,
          graded_by: prof.id,
          graded_at: daysAgo(Math.max(1, (WEEKS_IN - p.week) * 7 - 3), 16),
        })
      }
    })

    docRows.push({
      id: det(`doc-${t.key}`),
      team_id: teamId,
      title: 'Project plan',
      content: {
        html:
          `<h2>${t.name} — project plan</h2>` +
          `<p><strong>Decision:</strong> ${t.idea}.</p>` +
          `<p><strong>Baseline:</strong> majority class for the classification framing, and last-observed-value ` +
          `for the temporal framing. We have to beat both to claim anything.</p>` +
          `<h3>Split</h3><p>Forward in time. Train on the first 70% of the window, validate on the next 15%, ` +
          `hold out the final 15% and touch it once.</p>` +
          `<h3>Open questions</h3><ul>${TEAM_OPEN_QUESTIONS[t.key].map((q) => `<li>${q}</li>`).join('')}</ul>`,
      },
      is_pinned: true,
      position: 0,
      created_by: members[0].id,
      updated_by: members[1].id,
      created_at: daysAgo(WEEKS_IN * 7 - 28, 12),
    })

    const chat = TEAM_CHATS[t.key]
    chat.forEach((m, mi) => {
      messageRows.push({
        id: det(`team-msg-${t.key}-${mi}`),
        channel_id: det(m.ch === 'data' ? `team-channel-${t.key}-data` : `team-channel-${t.key}`),
        author_id: members[m.by].id,
        content: m.text,
        kind: 'user',
        created_at: daysAgo(m.back, 13 + (mi % 6)),
      })
    })

    commentRows.push({
      id: det(`phase-comment-${t.key}`),
      phase_id: det(`phase-${t.key}-${PHASES[1].key}`),
      author_id: prof.id,
      content: TEAM_PHASE_COMMENTS[t.key],
      created_at: daysAgo(Math.max(2, (WEEKS_IN - PHASES[1].week) * 7 - 2), 11),
    })

    // Real, existing videos rather than a fake made-up id — one that resolves
    // is a better demo outcome than one that only passes isSafeHttpUrl().
    const walkthroughUrl = TEAM_WALKTHROUGH_VIDEOS[t.key]
    // The meetings tab was empty in every team — a workspace surface with a
    // header and nothing under it. Three past meetings and one upcoming, so
    // the panel shows both states.
    //
    // meet_url stays null on purpose. MeetingsPanel only renders the join link
    // when one is set, and a fabricated Meet URL that dead-ends on click is a
    // worse demo than a meeting with no link attached.
    TEAM_MEETINGS.forEach((mt, mti) => {
      meetingRows.push({
        id: det(`meeting-${t.key}-${mti}`),
        team_id: teamId,
        project_id: projectId,
        section_id: main.id,
        created_by: members[mti % members.length].id,
        title: mt.title,
        scheduled_start: daysAgo(mt.back, 18),
        meet_url: null,
        notes_url: null,
        notes_label: null,
        reminded_at: null,
        created_at: daysAgo(mt.back + 3, 10),
      })
    })

    videoRows.push({
      id: det(`video-${t.key}`),
      project_id: projectId,
      team_id: teamId,
      uploaded_by: members[0].id,
      title: `${t.name} — phase 2 walkthrough`,
      description: `A short walkthrough of our approach: ${t.idea}.`,
      video_url: walkthroughUrl,
      video_path: walkthroughUrl,
      is_primary: true,
    })
  })

  await up('project_teams', teamRows)
  await up('project_chat_channels', channelRows)
  await up('project_members', memberRows)

  // trg_project_members_emit_join stamps its "X joined the team" system
  // message with the real insert-time now(), not a term-relative date — a
  // real trigger side effect the seed doesn't otherwise control. Left alone,
  // every team's chat reads as though its members joined today, underneath a
  // history that starts weeks earlier (found by red-team audit). Backdate to
  // the same team-formation timestamp the channel itself carries.
  for (const [channelId, formedAt] of defaultChannelFormedAt) {
    const { error } = await db
      .from('project_chat_messages')
      .update({ created_at: formedAt })
      .eq('channel_id', channelId)
      .eq('kind', 'system')
      .eq('system_event', 'member_joined')
    if (error) throw new Error(`backdate member_joined messages for ${channelId}: ${error.message}`)
  }

  await up('project_phases', phaseRows)
  await up('phase_items', itemRows)
  await up('phase_comments', commentRows)
  await up('project_docs', docRows)
  await up('project_chat_messages', messageRows)
  await up('project_item_scores', scoreRows)
  await up('team_availability', availRows)
  await up('team_meetings', meetingRows)
  await up('project_videos', videoRows)

  // project_showcase.project_id is UNIQUE — one row for the whole shared
  // project, not one per team. Readmit Radar is the furthest along
  // (progress: 0.85), so it's the one a professor would actually feature.
  const featuredTeam = TEAMS[0]
  await up('project_showcase', [
    {
      id: det('project-showcase'),
      project_id: projectId,
      team_id: det(`team-${featuredTeam.key}`),
      published_by: prof.id,
      tagline: `${featuredTeam.name}: ${featuredTeam.idea}.`,
      external_url: TEAM_WALKTHROUGH_VIDEOS[featuredTeam.key],
      is_featured: true,
      // Not tied to the final phase's due date — showcase_enabled is a
      // standing toggle, and a professor can feature strong in-progress work
      // mid-term to set an example, not only graded final submissions.
      published_at: daysAgo(3, 10),
    },
  ])

  await up(
    'team_meeting_rooms',
    teamIds.slice(0, 2).map((id, i) => ({
      team_id: id,
      meet_url: `https://meet.google.com/demo-cs340-${i + 1}`,
      updated_by: main.students[i * 3].id,
      updated_at: daysAgo(9),
    })),
    'team_id',
  )

  // A message reaction, and one deleted message, so those states are represented.
  await up('project_chat_message_reactions', [
    {
      id: det('chat-react-1'),
      message_id: det('team-msg-readmit-4'),
      user_id: main.students[1].id,
      emoji: '🔥',
      created_at: daysAgo(20, 14),
    },
  ])

  // Grades: the top two teams have a released overall grade.
  TEAMS.slice(0, 2).forEach((t, i) => {
    gradeRows.push({
      id: det(`project-grade-${t.key}`),
      team_id: det(`team-${t.key}`),
      project_id: projectId,
      graded_by: prof.id,
      score: 88 - i * 6,
      feedback:
        i === 0
          ? 'The leakage finding and how you handled it is exactly what this project is for. Presentation needs to lead with it.'
          : 'Strong pipeline. The evaluation section understates what you actually did — say the number and defend it.',
      graded_at: daysAgo(7, 15),
    })
  })
  await up('project_grades', gradeRows)
  await up(
    'project_grade_releases',
    [{ project_id: projectId, institution_id: INSTITUTION_ID, released_at: daysAgo(6, 9), released_by: prof.id }],
    'project_id',
  )

  // The project as a gradebook item, wired to the category seeded in assessments.
  await up('grade_category_items', [
    {
      id: det('grade-item-project'),
      category_id: grades.projectCategoryId,
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      item_type: 'project',
      item_id: projectId,
      is_extra_credit: false,
    },
  ])

  // Two students who are not yet on a team: one invited, one requesting.
  const spare = main.students.slice(TEAMS.length * 3)
  if (spare.length >= 1) {
    await up('team_invitations', [
      {
        id: det('team-invite-1'),
        team_id: det('team-triage'),
        project_id: projectId,
        section_id: main.id,
        invited_by: main.students[9].id,
        invited_user_id: spare[0].id,
        message: 'We are one short and you said you wanted the text project. Come join us.',
        status: 'pending',
        created_at: daysAgo(3, 16),
      },
    ])
  }
  if (spare.length >= 2) {
    await up('team_join_requests', [
      {
        id: det('team-request-1'),
        team_id: det('team-shelf'),
        project_id: projectId,
        section_id: main.id,
        user_id: spare[1].id,
        message: 'I have worked with the dining hall data before and would like to join if you have room.',
        status: 'pending',
        created_at: daysAgo(2, 12),
      },
    ])
  }

  ok(`project: ${TEAMS.length} teams, ${phaseRows.length} phases, ${messageRows.length} chat messages, ${gradeRows.length} released grades`)
  return { projectId, teamIds, teamMembers }
}

// ── Course discussions ────────────────────────────────────────────────

async function seedDiscussions(campus: Campus, collab: Collab) {
  const main = campus.main
  const prof = main.professor
  const ta = campus.roster.assistants[0]
  const s = main.students

  const channels = [
    { key: 'general', name: 'general', pos: 0, isDefault: true },
    { key: 'homework', name: 'homework-help', pos: 1, isDefault: false },
    { key: 'projects', name: 'project-chat', pos: 2, isDefault: false },
  ]
  await up(
    'discussion_channels',
    channels.map((c) => ({
      id: det(`channel-${c.key}`),
      section_id: main.id,
      team_id: null,
      scope: 'course',
      name: c.name,
      created_by: prof.id,
      is_default: c.isDefault,
      status: 'active',
      position: c.pos,
      created_at: daysAgo(WEEKS_IN * 7, 9),
    })),
  )

  // Nine weeks of a course board, ordered oldest first. Twelve messages in
  // three two-day clumps was the old version, and it read as a channel nobody
  // used: a demo that opens Discussions saw the whole term's traffic in one
  // screen. Volume here is the feature. The dates track the curriculum, so a
  // question about lasso lands in the week lasso was taught rather than
  // floating free of the syllabus beside it.
  const thread: Array<{ ch: string; by: Person; text: string; back: number }> = [
    // ── Week 1: what ML can and cannot do ──
    { ch: 'general', by: prof, text: 'Channel is open. Ask here rather than emailing me — the answer usually helps more than one person.', back: 62 },
    { ch: 'general', by: s[0], text: 'Is the Thursday session a lecture or a lab? The catalog says one and the syllabus says the other.', back: 61 },
    { ch: 'general', by: ta, text: 'Lecture. The lab slot got folded into office hours this term — those are Wednesday afternoons.', back: 61 },
    { ch: 'general', by: s[5], text: 'For the reading, are we expected to get through the whole chapter or just the first half?', back: 60 },
    { ch: 'general', by: prof, text: 'First half before Tuesday. The second half is the week 2 material and it will make more sense after we have talked about leakage.', back: 60 },
    { ch: 'general', by: s[8], text: 'Slightly off topic, but is there a recommended refresher for linear algebra? Mine is rusty.', back: 58 },
    { ch: 'general', by: ta, text: 'You mostly need matrix multiplication and what an eigenvector is. If you can follow a dot product you will be fine for the first month.', back: 58 },

    // ── Week 2: data, features, leakage ──
    { ch: 'general', by: s[3], text: 'The leakage example in today’s lecture broke my brain a little. The model was right and that was the problem?', back: 55 },
    { ch: 'general', by: prof, text: 'Yes. If a feature is populated as a consequence of the outcome, then knowing it is the same as knowing the answer. The model is working perfectly and telling you nothing.', back: 55 },
    { ch: 'homework', by: s[3], text: 'HW1: does "state the decision" mean the business decision, or the modelling decision like classification versus regression?', back: 53 },
    { ch: 'homework', by: prof, text: 'The business one. Who does something differently because of this prediction, and what do they do? The modelling choice should fall out of that answer rather than lead it.', back: 53 },
    { ch: 'homework', by: s[7], text: 'Do we need to handle the missing values in the tenure column, or can we drop those rows?', back: 52 },
    { ch: 'homework', by: ta, text: 'Either is defensible, but say which you did and why. If you drop them, check first whether they are missing at random — they are not, and that is worth a sentence.', back: 52 },
    { ch: 'homework', by: s[10], text: 'Oh, that is a good catch. The missing ones are almost all recent signups.', back: 51 },
    { ch: 'general', by: s[1], text: 'Does anyone have a good mental model for when a temporal split is required versus just nice to have?', back: 50 },
    { ch: 'general', by: ta, text: 'Ask whether the model will ever predict backwards in deployment. If it will not, your evaluation should not either.', back: 50 },

    // ── Week 3: linear regression and regularization ──
    { ch: 'homework', by: s[3], text: 'For HW2, does "report the validation curve" mean one plot per model or all three on the same axes?', back: 47 },
    { ch: 'homework', by: ta, text: 'Same axes. It makes the comparison readable and that is the point of the question.', back: 47 },
    { ch: 'homework', by: s[7], text: 'My lasso is zeroing out everything. Is that expected?', back: 46 },
    { ch: 'homework', by: ta, text: 'Your lambda is too high, or you did not scale before fitting. Lasso is scale-sensitive in a way ridge is more forgiving about.', back: 46 },
    { ch: 'homework', by: s[7], text: 'It was the scaling. Thank you.', back: 46 },
    { ch: 'homework', by: s[11], text: 'Follow-up on that — should the scaler go inside the cross-validation loop or is fitting it once on the training set fine?', back: 45 },
    { ch: 'homework', by: prof, text: 'Inside. Fitting it once on the full training set leaks the validation fold into the scaling, which is a small effect here and a large one on smaller datasets. Build the habit now.', back: 45 },
    { ch: 'general', by: s[4], text: 'Is there an intuition for why ridge shrinks coefficients but does not zero them and lasso does?', back: 44 },
    { ch: 'general', by: prof, text: 'Draw the constraint region for each. The L1 ball has corners on the axes and the L2 ball does not, so the solution touches it at a corner — and a corner means a coefficient is exactly zero.', back: 44 },
    { ch: 'general', by: s[4], text: 'That picture helped more than the algebra did. Thanks.', back: 44 },

    // ── Week 4: classification and metrics ──
    { ch: 'general', by: s[9], text: 'Quiz 2 question 3 — I put "the validation set" and it was marked wrong. Is the distinction from the test set really that strict?', back: 40 },
    { ch: 'general', by: prof, text: 'It is, and it is the single most common way people fool themselves. I am going to post a longer note on this rather than answer it in one line.', back: 40 },
    { ch: 'homework', by: s[2], text: 'HW3: is there a standard place to get a cost ratio, or do we invent one and justify it?', back: 38 },
    { ch: 'homework', by: prof, text: 'Invent one and defend it. There is no right answer — the point is that you cannot pick a threshold without committing to a number, and most people pick a threshold anyway and pretend they did not.', back: 38 },
    { ch: 'homework', by: s[6], text: 'My precision-recall curve is very jagged at the high-recall end. Bug or just the small positive class?', back: 37 },
    { ch: 'homework', by: ta, text: 'Small positive class. With around sixty positives in your test fold, each one moves recall by nearly two points, so the curve steps rather than sweeps. Worth a sentence in the write-up.', back: 37 },
    { ch: 'general', by: s[8], text: 'Can someone sanity check me: macro F1 averages the per-class F1, and weighted F1 weights by support. So on an imbalanced problem macro is the harsher one?', back: 36 },
    { ch: 'general', by: s[0], text: 'That is how I have it. Weighted mostly tells you about the majority class, which is usually the one you care about least.', back: 36 },

    // ── Week 5: trees and ensembles ──
    { ch: 'general', by: s[5], text: 'Is there a reason we implement the tree from scratch rather than just using the library? Genuine question, not complaining.', back: 33 },
    { ch: 'general', by: prof, text: 'Because the gap between your tree and the library one is the whole lesson of the week, and you cannot feel that gap if both sides are a black box.', back: 33 },
    { ch: 'homework', by: s[10], text: 'HW4: my recursion is not terminating on the full dataset and I cannot work out why. Depth cap is set.', back: 31 },
    { ch: 'homework', by: ta, text: 'Check for duplicate rows with different labels. No split separates them, so the node is never pure and never splits usefully — you need a stopping condition for "no split improves impurity".', back: 31 },
    { ch: 'homework', by: s[10], text: 'That was exactly it. Eleven duplicate pairs. Thank you, I would have been there all night.', back: 31 },
    { ch: 'homework', by: s[2], text: 'How slow is too slow for the from-scratch tree? Mine takes about four minutes.', back: 30 },
    { ch: 'homework', by: prof, text: 'Under five is the rubric line, so you are fine. If you want it faster, sort each feature once per node and sweep the class counts rather than recomputing impurity from scratch at every candidate.', back: 30 },
    { ch: 'general', by: s[1], text: 'Random forest got me a big jump over my single tree and I am not sure I can explain why beyond "averaging".', back: 29 },
    { ch: 'general', by: ta, text: 'Try refitting your single tree on a few bootstrap resamples and look at how much the predictions disagree with each other. That disagreement is the variance the forest is averaging away.', back: 29 },

    // ── Week 6: model selection and cross-validation ──
    { ch: 'general', by: s[0], text: 'Is anyone else finding the week 6 reading heavier than the others, or is that just me?', back: 26 },
    { ch: 'general', by: s[4], text: 'Not just you. Nested CV took me two passes. The diagram in the notes helped more than the text.', back: 26 },
    { ch: 'general', by: s[6], text: 'What actually goes wrong if you skip the outer loop and just report the best inner score?', back: 25 },
    { ch: 'general', by: prof, text: 'You report the maximum of a noisy quantity over many candidates, which is biased upward by construction. The outer loop exists to give that number an honest test set it never touched.', back: 25 },
    { ch: 'general', by: s[6], text: 'So the number is optimistic in proportion to how many things I tried. That is uncomfortable.', back: 25 },
    { ch: 'general', by: prof, text: 'It should be. That discomfort is the correct response and most published results do not have it.', back: 24 },

    // ── Week 7: feature engineering, project kickoff ──
    { ch: 'projects', by: s[1], text: 'PSA for everyone: check whether your status/outcome fields are populated after the event. Ours was and it was inflating our AUC by 0.23.', back: 21 },
    { ch: 'projects', by: prof, text: 'This is the single most useful message in this channel. Everyone go and check.', back: 20 },
    { ch: 'projects', by: s[6], text: 'Ours too. Well, that explains a lot.', back: 20 },
    { ch: 'projects', by: s[9], text: 'How simple is too simple for a baseline? Ours is one column and a threshold and it feels like cheating.', back: 19 },
    { ch: 'projects', by: prof, text: 'That is not too simple, that is correct. If your model cannot beat one column and a threshold, you have learned something important and cheaply.', back: 19 },
    { ch: 'projects', by: s[3], text: 'Are we allowed to bring in an outside dataset to join against, or does it have to be the one we were given?', back: 18 },
    { ch: 'projects', by: prof, text: 'Allowed, and encouraged if it is defensible. Say where it came from and check the join does not quietly drop half your rows.', back: 18 },
    { ch: 'projects', by: s[7], text: 'Our join dropped 40% of rows and we nearly did not notice. Checking the row count before and after is now the first cell in our notebook.', back: 17 },
    { ch: 'homework', by: s[11], text: 'For target encoding, does the same inside-the-fold rule apply as for scaling?', back: 16 },
    { ch: 'homework', by: prof, text: 'Same rule and it matters far more here. Target encoding computed on the full frame leaks the label directly, which is about as bad as it gets.', back: 16 },

    // ── Week 8: midterm ──
    { ch: 'general', by: s[8], text: 'For the midterm, is the from-scratch tree code examinable or just the concepts?', back: 13 },
    { ch: 'general', by: prof, text: 'Concepts. You will not write code under exam conditions, but you may be asked why a stopping condition is needed and what happens without it.', back: 13 },
    { ch: 'general', by: s[2], text: 'Is the formula sheet provided or do we bring our own?', back: 12 },
    { ch: 'general', by: ta, text: 'Provided, and it is linked on the quiz page. Have a look before the exam so you are not reading it for the first time under time pressure.', back: 12 },
    { ch: 'general', by: s[5], text: 'Weeks 1 through 7 confirmed? Week 8 is review so I assume it is not on it.', back: 11 },
    { ch: 'general', by: prof, text: 'Confirmed, 1 through 7.', back: 11 },
    { ch: 'general', by: s[0], text: 'Good luck everyone.', back: 10 },
    { ch: 'general', by: s[4], text: 'That was fairer than I expected. The threshold question was the one that cost me.', back: 9 },
    { ch: 'general', by: s[9], text: 'Same. I knew the material and misread what it was asking for.', back: 9 },

    // ── Week 9: neural networks ──
    { ch: 'general', by: s[11], text: 'Backprop finally clicked when I wrote out the chain rule for a two-layer net by hand. Recommending that to anyone still stuck.', back: 7 },
    { ch: 'general', by: s[3], text: 'Seconded. The matrix version hid what was going on for me until I did the scalar case first.', back: 7 },
    { ch: 'homework', by: s[6], text: 'HW5: my first run diverged immediately. Is that a learning rate thing or have I broken the gradients?', back: 5 },
    { ch: 'homework', by: ta, text: 'Almost always the learning rate. Print the gradient norm for the first twenty steps — if it climbs, drop the rate by an order of magnitude and add warmup before you go looking for bugs.', back: 5 },
    { ch: 'homework', by: s[6], text: 'Gradient norm was hitting 300 by step two. Warmup fixed it. Leaving the failed run in the notebook as evidence.', back: 5 },
    { ch: 'homework', by: s[2], text: 'How do you tell bias from variance off the learning curve when both curves are still moving?', back: 4 },
    { ch: 'homework', by: prof, text: 'Train longer until they stop. If they converge together and high, that is bias; if they separate and the gap holds, that is variance. Diagnosing mid-training is guessing.', back: 4 },
    { ch: 'projects', by: s[5], text: 'Phase 2 is in. The honest number is a lot lower than the leaky one and writing that up was harder than the modelling.', back: 3 },
    { ch: 'projects', by: prof, text: 'That write-up is the part I will remember at the end of term. Leading with a number you had to argue yourself down to is the whole skill.', back: 3 },
    { ch: 'general', by: s[10], text: 'Reminder that Quiz 4 closes at 7pm sharp, not midnight. Learned that the hard way last time.', back: 2 },
    { ch: 'general', by: s[8], text: 'Thank you, I had it in my calendar for midnight.', back: 2 },
  ]
  await up(
    'discussion_messages',
    thread.map((m, i) => ({
      id: det(`disc-msg-${i}`),
      channel_id: det(`channel-${m.ch}`),
      author_id: m.by.id,
      content: m.text,
      created_at: daysAgo(m.back, 10 + (i % 9)),
    })),
  )
  // Reactions were two rows on a single message. Spread across the messages
  // that would actually draw one — the leakage PSA, the recursion fix, the
  // constraint-region explanation — so the board reads as read rather than
  // merely written to.
  const reactions: Array<{ msg: number; by: Person; emoji: string }> = [
    { msg: 50, by: s[6], emoji: '🙏' },
    { msg: 50, by: s[2], emoji: '👀' },
    { msg: 50, by: s[9], emoji: '🙏' },
    { msg: 50, by: s[11], emoji: '👀' },
    { msg: 51, by: s[3], emoji: '👍' },
    { msg: 24, by: s[8], emoji: '🙌' },
    { msg: 24, by: s[1], emoji: '👍' },
    { msg: 24, by: s[10], emoji: '🙌' },
    { msg: 38, by: s[2], emoji: '🙏' },
    { msg: 38, by: s[5], emoji: '👍' },
    { msg: 12, by: s[10], emoji: '👀' },
    { msg: 22, by: s[11], emoji: '🙏' },
    { msg: 22, by: s[4], emoji: '👍' },
    { msg: 64, by: s[8], emoji: '🙏' },
    { msg: 71, by: s[3], emoji: '🙌' },
    { msg: 71, by: s[0], emoji: '👍' },
    { msg: 75, by: s[6], emoji: '🙏' },
    { msg: 77, by: s[5], emoji: '🙌' },
    { msg: 77, by: s[1], emoji: '👍' },
    { msg: 76, by: s[8], emoji: '🙏' },
  ]
  await up(
    'discussion_message_reactions',
    reactions.map((r, i) => ({
      id: det(`disc-react-${i}`),
      message_id: det(`disc-msg-${r.msg}`),
      user_id: r.by.id,
      emoji: r.emoji,
      created_at: daysAgo(Math.max(0, thread[r.msg].back - 1), 15 + (i % 6)),
    })),
  )

  // Private per-team channels, which is what scope='team' is for.
  await up(
    'discussion_channels',
    collab.teamIds.map((teamId, i) => ({
      id: det(`team-disc-${i}`),
      section_id: main.id,
      team_id: teamId,
      scope: 'team',
      name: TEAMS[i].name,
      created_by: prof.id,
      is_default: false,
      status: 'active',
      position: 10 + i,
      created_at: daysAgo(WEEKS_IN * 7 - 30, 14),
    })),
  )
  ok(`discussions: ${channels.length} course channels + ${collab.teamIds.length} team channels, ${thread.length} messages`)
}

// ── Direct messages ───────────────────────────────────────────────────

async function seedDirectMessages(campus: Campus) {
  const main = campus.main
  const prof = main.professor
  const ta = campus.roster.assistants[0]
  const s = main.students

  // dm_channels stores the pair in sorted-uuid order, which is what the unique
  // constraint matches on. Sorting here rather than at read time keeps lookups
  // a single constraint hit.
  const pairs: Array<{ key: string; a: Person; b: Person; msgs: Array<{ from: 'a' | 'b'; text: string; back: number }> }> = [
    {
      key: 'prof-priya', a: prof, b: s[0],
      msgs: [
        { from: 'b', text: 'Hi Professor — I am going to miss Thursday, I have a clinic appointment. Is there anything I should catch up on beyond the notes?', back: 5 },
        { from: 'a', text: 'Thanks for telling me. Watch the session recording and do the week 9 checklist. The network we build in class is the one HW5 asks for.', back: 5 },
        { from: 'b', text: 'Will do, thank you.', back: 5 },
      ],
    },
    {
      key: 'ta-jonah', a: ta, b: s[1],
      msgs: [
        { from: 'b', text: 'Is the regrade window still open for HW3?', back: 12 },
        { from: 'a', text: 'Until Friday. Open it from the submission page rather than messaging me, so it lands in the queue with the rubric attached.', back: 12 },
      ],
    },
    {
      key: 'mei-tobias', a: s[2], b: s[3],
      msgs: [
        { from: 'a', text: 'Are you going to office hours Thursday? I want to ask about the split for our phase 2.', back: 4 },
        { from: 'b', text: 'Yes, booked the 2:30 slot. Meet outside?', back: 4 },
        { from: 'a', text: 'Perfect.', back: 3 },
      ],
    },
  ]

  const channels: Record<string, unknown>[] = []
  const messages: Record<string, unknown>[] = []
  const cursors: Record<string, unknown>[] = []

  for (const p of pairs) {
    const [ua, ub] = [p.a.id, p.b.id].sort()
    const channelId = det(`dm-${p.key}`)
    const last = p.msgs[p.msgs.length - 1]
    channels.push({
      id: channelId,
      user_a_id: ua,
      user_b_id: ub,
      last_message_at: daysAgo(last.back, 17),
      created_at: daysAgo(p.msgs[0].back, 9),
    })
    p.msgs.forEach((m, i) => {
      messages.push({
        id: det(`dm-msg-${p.key}-${i}`),
        channel_id: channelId,
        author_id: m.from === 'a' ? p.a.id : p.b.id,
        content: m.text,
        created_at: daysAgo(m.back, 9 + i * 2),
      })
    })
    // The initiator has read everything; the other side has one unread.
    cursors.push({ channel_id: channelId, user_id: p.a.id, last_read_at: daysAgo(last.back, 18) })
    cursors.push({ channel_id: channelId, user_id: p.b.id, last_read_at: daysAgo(last.back + 1, 18) })
  }

  await up('dm_channels', channels)
  await up('dm_messages', messages)
  await up('dm_read_cursors', cursors, 'channel_id,user_id')
  ok(`direct messages: ${channels.length} threads, ${messages.length} messages`)
}

// ── Challenges, badges, certificates ──────────────────────────────────

async function seedChallenges(campus: Campus) {
  const main = campus.main
  const prof = main.professor
  const s = main.students

  await up('badges', [
    {
      id: det('badge-debugger'),
      section_id: main.id,
      created_by: prof.id,
      name: 'Leak Hunter',
      description: 'Found and documented a real data leak before it reached a model.',
      icon: '🔍',
      created_at: daysAgo(WEEKS_IN * 7 - 10),
    },
    {
      id: det('badge-baseline'),
      section_id: main.id,
      created_by: prof.id,
      name: 'Baseline Believer',
      description: 'Beat a genuinely hard baseline and showed the working.',
      icon: '📐',
      created_at: daysAgo(WEEKS_IN * 7 - 10),
    },
  ])

  const challenges = [
    {
      key: 'leak', title: 'Find the leak', type: 'puzzle', difficulty: 'medium', points: 30,
      badge: det('badge-debugger'), daysBack: 26, due: -10,
      desc: 'The attached notebook reports 0.98 AUC on a churn dataset. Find the leak, explain how it got there, and report the honest number after you fix it.',
    },
    {
      key: 'baseline', title: 'Beat the dumb baseline', type: 'coding', difficulty: 'hard', points: 40,
      badge: det('badge-baseline'), daysBack: 18, due: -4,
      desc: 'A last-observed-value baseline gets 0.61 on the provided time series. Beat it by five points without using any feature computed from the future.',
    },
    {
      key: 'explain', title: 'Explain it to a stakeholder', type: 'creative', difficulty: 'easy', points: 20,
      badge: null, daysBack: 9, due: -12,
      desc: 'In under 200 words and no equations, explain to a hospital administrator what your model does, what it does not do, and when they should ignore it.',
    },
    {
      key: 'reading', title: 'Paper of the week: Bender et al.', type: 'discussion', difficulty: 'easy', points: 15,
      badge: null, daysBack: 4, due: -6,
      desc: 'Read the paper and post one claim you agree with and one you think is overstated, with a reason for each.',
    },
  ]

  await up(
    'challenges',
    challenges.map((c) => ({
      id: det(`challenge-${c.key}`),
      section_id: main.id,
      created_by: prof.id,
      title: c.title,
      description: c.desc,
      type: c.type,
      difficulty: c.difficulty,
      points: c.points,
      bonus_points: c.difficulty === 'hard' ? 10 : 0,
      badge_id: c.badge,
      visibility: 'published',
      source: 'instructor',
      max_claims: null,
      due_at: daysAgo(c.due, 19),
      created_at: daysAgo(c.daysBack, 10),
    })),
  )

  const claims: Record<string, unknown>[] = []
  const submissions: Record<string, unknown>[] = []
  const statuses = ['approved', 'approved', 'submitted', 'claimed', 'rejected'] as const
  challenges.forEach((c, ci) => {
    // Cycling the status by (challenge + student) gave every challenge the same
    // multiset, so all four cards read "5 claimed · 1 to review · 2 approved".
    // Vary both who claims and what happened to it.
    const rollStatus = rng(`claims-${c.key}`)
    s.slice(0, 5 + (ci % 3)).forEach((st) => {
      const status = statuses[Math.floor(rollStatus() * statuses.length)]
      const claimId = det(`claim-${c.key}-${st.key}`)
      claims.push({
        id: claimId,
        challenge_id: det(`challenge-${c.key}`),
        user_id: st.id,
        status,
        reviewer_note:
          status === 'approved'
            ? 'Correct, and the explanation of how it got there is the part that earns the marks.'
            : status === 'rejected'
              ? 'You found a correlated feature, not the leak. Look at when the field is written, not what it correlates with.'
              : null,
        reviewed_by: status === 'approved' || status === 'rejected' ? prof.id : null,
        reviewed_at: status === 'approved' || status === 'rejected' ? daysAgo(Math.max(1, c.daysBack - 4), 16) : null,
        claimed_at: daysAgo(c.daysBack - 1, 12),
      })
      if (status !== 'claimed') {
        const subPick = rng(`sub-${c.key}-${st.key}`)
        submissions.push({
          id: det(`challenge-sub-${c.key}-${st.key}`),
          claim_id: claimId,
          submission_type: c.type === 'coding' ? 'github' : 'text',
          // Different students reach the same correct finding by different
          // paths — vary the wording, not the underlying fact, so two approved
          // submissions on the same challenge never read as copy-pasted.
          content:
            c.key === 'leak'
              ? pick(subPick, [
                  'The `account_status` column is written by the nightly job AFTER cancellation, so it partially encodes the label. Dropping it takes AUC from 0.98 to 0.74, which is the honest number.',
                  'Found it by checking column write times against the label — `account_status` gets updated post-cancellation, so it is leaking. AUC drops from 0.98 to 0.74 once it is removed.',
                  '`account_status` is the leak. It is set by a nightly batch job that runs after the outcome is known. Re-ran without it: 0.74 AUC, which is the number I would actually trust.',
                ])
              : `Write-up attached. Baseline 0.61, ours ${(0.61 + 0.05 + subPick() * 0.04).toFixed(2)}, no future-derived features.`,
          url: c.type === 'coding' ? 'https://github.com/example/cs340-challenge' : null,
          created_at: daysAgo(Math.max(1, c.daysBack - 2), 21),
        })
      }
    })
  })
  await up('challenge_claims', claims)
  await up('challenge_submissions', submissions)

  await up(
    'user_badges',
    s.slice(0, 3).map((st, i) => ({
      id: det(`user-badge-${st.key}`),
      section_id: main.id,
      badge_id: i === 0 ? det('badge-debugger') : det('badge-baseline'),
      user_id: st.id,
      awarded_by: prof.id,
      reason: i === 0 ? 'Found the account_status leak and wrote it up clearly.' : 'Beat the time-series baseline honestly.',
      awarded_at: daysAgo(20 - i * 3, 16),
    })),
  )

  // A certificate awarded for completing the two hard challenges.
  const certId = det('certificate')
  await up('certificates', [
    {
      id: certId,
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      created_by: prof.id,
      title: 'CS 340 — Evidence-Based Modelling',
      description:
        'Awarded to students who found a real data leak and beat a hard baseline without using future information.',
      is_active: true,
      created_at: daysAgo(WEEKS_IN * 7 - 12),
    },
  ])
  await up(
    'certificate_challenges',
    ['leak', 'baseline'].map((k) => ({
      id: det(`cert-challenge-${k}`),
      certificate_id: certId,
      challenge_id: det(`challenge-${k}`),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
    })),
  )
  await up('student_certificates', [
    {
      id: det('student-cert-1'),
      certificate_id: certId,
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      student_id: s[0].id,
      public_id: 'NC340-EVB-4471',
      title: 'CS 340 — Evidence-Based Modelling',
      description: 'Found a real data leak and beat a hard baseline without using future information.',
      skills_snapshot: ['Data Leakage', 'Model Evaluation', 'Train/Test Splitting'],
      issued_at: daysAgo(12, 14),
      seen_at: daysAgo(11, 9),
    },
  ])

  ok(`${challenges.length} challenges, ${claims.length} claims, 2 badges, 1 certificate issued`)
}

// ── Office hours and calendars ────────────────────────────────────────

async function seedCalendars(campus: Campus) {
  const main = campus.main
  const prof = main.professor
  const s = main.students
  const courseId = campus.courseId

  await up(
    'office_hours',
    [
      { key: 'tue', day: 'tuesday', start: '14:00', end: '16:00', type: 'in_person', loc: main.location },
      { key: 'thu', day: 'thursday', start: '10:00', end: '11:30', type: 'zoom', loc: '' },
    ].map((o) => ({
      id: det(`office-hours-${o.key}`),
      professor_id: prof.id,
      title: `CS 340 office hours (${o.day})`,
      course_id: courseId,
      course_name: 'Applied Machine Learning',
      course_code: 'CS 340',
      day_of_week: o.day,
      start_time: o.start,
      end_time: o.end,
      slot_duration: 30,
      buffer_minutes: 5,
      meeting_type: o.type,
      // These columns are NOT NULL DEFAULT '' — an explicit null fails where an
      // empty string is what "no value" means here.
      location: o.loc,
      zoom_link: o.type === 'zoom' ? 'https://zoom.us/j/9998887777' : '',
      is_active: true,
      effective_from: isoDate(daysAgo(WEEKS_IN * 7)),
      effective_until: null,
    })),
  )

  const purposes = ['assignment_doubt', 'project_discussion', 'exam_prep', 'general_question', 'career_guidance'] as const
  const bookings = s.slice(0, 7).map((st, i) => {
    const future = i < 3
    const onTuesday = i % 2 === 0
    // A booking has to fall on the weekday its office-hours block actually runs,
    // and inside that block's hours. Picking an arbitrary offset put a Wednesday
    // and a Friday booking under a block titled "(tuesday)", and pushed the
    // start time outside the Thursday block's 10:00-11:30 window.
    const weekday = onTuesday ? 2 : 4
    // Each booking gets its own week AND its own half-hour slot: the schema has
    // a unique constraint on (office_hours_id, date, start_time), so two
    // students snapped to the same weekday at the same hour collide.
    const weeksAway = future ? -(Math.floor(i / 2) + 1) : Math.floor(i / 2) + 1
    const roughly = new Date(NOW.getTime() - weeksAway * 7 * 86_400_000)
    const slot = onWeekday(roughly, weekday, onTuesday ? 14 : 10)
    const baseHour = onTuesday ? 14 : 10
    const halfHours = i % 3
    const hour = baseHour + Math.floor(halfHours / 2)
    const minute = (halfHours % 2) * 30
    return {
      id: det(`booking-${st.key}`),
      office_hours_id: det(onTuesday ? 'office-hours-tue' : 'office-hours-thu'),
      professor_id: prof.id,
      student_id: st.id,
      date: isoDate(slot.toISOString()),
      start_time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      end_time: minute === 0
        ? `${String(hour).padStart(2, '0')}:30`
        : `${String(hour + 1).padStart(2, '0')}:00`,
      title: future ? 'Project phase 2 check-in' : 'Homework question',
      course_id: courseId,
      course_name: 'Applied Machine Learning',
      course_code: 'CS 340',
      meeting_type: onTuesday ? 'in_person' : 'zoom',
      purpose: purposes[i % purposes.length],
      student_note:
        i % 3 === 0
          ? 'I want to check our split before we submit phase 2.'
          : 'Stuck on why my lasso zeroes everything out.',
      professor_note: future ? '' : 'Walked through the scaling issue. Resolved.',
      location: onTuesday ? main.location : '',
      zoom_link: onTuesday ? '' : 'https://zoom.us/j/9998887777',
      status: future ? 'booked' : i === 6 ? 'cancelled' : 'completed',
      cancelled_by: i === 6 ? 'student' : null,
      cancellation_reason: i === 6 ? 'Resolved it on the discussion board instead.' : '',
      created_at: daysAgo(weeksAway * 7 + 3, 11),
    }
  })
  await up('bookings', bookings)

  await up('blocked_times', [
    {
      id: det('blocked-1'),
      professor_id: prof.id,
      date: isoDate(daysAgo(-9)),
      start_time: '14:00',
      end_time: '16:00',
      // `reason` is a constrained category, not free text; the human sentence
      // belongs in `note`.
      reason: 'meeting',
      note: 'Faculty meeting — no office hours this week, email instead.',
      recurrence: 'none',
      course_id: courseId,
      course_name: 'Applied Machine Learning',
      course_code: 'CS 340',
      meeting_type: 'in_person',
      location: main.location,
    },
  ])

  await up(
    'personal_events',
    s.slice(0, 6).flatMap((st, i) => [
      {
        id: det(`personal-${st.key}-study`),
        student_id: st.id,
        institution_id: INSTITUTION_ID,
        title: 'CS 340 study group',
        date: isoDate(daysAgo(-(i % 5) - 1)),
        start_time: '19:00',
        end_time: '21:00',
        all_day: false,
        note: 'Library, third floor.',
        recurrence: 'weekly',
        recurrence_until: isoDate(daysAgo(-40)),
      },
      {
        id: det(`personal-${st.key}-deadline`),
        student_id: st.id,
        institution_id: INSTITUTION_ID,
        title: 'HW5 — start early',
        date: isoDate(daysAgo(-4)),
        all_day: true,
        note: null,
        recurrence: 'none',
      },
    ]),
  )

  ok(`calendars: 2 office-hour blocks, ${bookings.length} bookings, 12 personal events`)
}

// ── Entry point ───────────────────────────────────────────────────────

export async function seedCollab(campus: Campus, grades: Assessments): Promise<Collab> {
  phase('Project, discussions, messages, challenges, calendars')
  const collab = await seedProject(campus, grades)
  await seedDiscussions(campus, collab)
  await seedDirectMessages(campus)
  await seedChallenges(campus)
  await seedCalendars(campus)
  return collab
}
