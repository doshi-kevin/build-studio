# User Signals — What Professors and Students Actually Want

Reference doc behind the **Who We Build For** section of `CLAUDE.md`. That section holds the
principles; this file holds the evidence, so briefs and design docs can cite specific numbers
without paying for them in every session's context.

Two sources: our own user interviews, and public 2025 survey research that corroborates them.

**Read the caveat in "Source quality" before quoting any percentage externally.**

---

## Professors: the currency is time

Their binding constraint is workload, not capability. They will pay to have a step removed.

| Signal | Number | Source |
|---|---|---|
| Instructors spending 4+ hours/week answering repetitive student questions (assignments, deadlines, course materials) | **36%** (24% at 4–6h, 12% at 6h+) | Anthology 2025 |
| Report workload has increased over the last five years | **6 in 10** | Anthology 2025 |
| Biggest self-reported barrier to delivering effective learning | "lack of time to update courses" | Anthology 2025 |
| Cite *workload* as a top barrier to reaching out to struggling students | **32%** (30% cite "lack of time") | Anthology 2025 |

**Implication:** a feature that removes a repeated action, batches it, or pre-fills it from data
we already hold is worth more than a feature that adds capability behind configuration.

## Professors: they will not go looking

| Signal | Number | Source |
|---|---|---|
| Faculty who regularly explore new features in their LMS | **~15%** | Anthology 2025 |
| Review course content for accessibility only "when time allows" | **~40%** | Anthology 2025 |

**Implication — the sharpest one in this doc.** Discoverability is not a polish item, it's the
whole feature. A professor tool placed behind a new nav destination effectively does not exist.
It has to surface inside the workflow they are already in. Anthology draws the same conclusion
about their own accessibility product: rather than "requiring instructors to learn a new system,"
it surfaces issues "directly within their existing workflows."

Relevant to: Athena's entry points, the Manage Features panel, anything shipped under a new tab.

## Professors: more technology is not automatically less work

| Signal | Number | Source |
|---|---|---|
| Instructors who feel "always on the job" *because of* technology | **79%** | Anthology 2025 |

Anthology's own framing: "when used incorrectly, technology can worsen the issue," and
well-intentioned measurement initiatives "have often simply added a further drag on their time."

**Implication:** don't mistake surfacing more information for saving time. Be especially careful
about opting professors into notification streams, digests, or dashboards by default.

## Students: the currency is logistical overhead

Not "accessibility" in the a11y/WCAG sense — that's a separate, non-negotiable requirement
covered by `.claude/rules/ui-design.md`. This is about how much tracking and navigating the
student has to do across *several courses at once*.

| Signal | Number | Source |
|---|---|---|
| Students who have missed a critical deadline (assignment, payment, registration) because they didn't know it was due | **47%** | Pathify 2025 |
| Spend more than 5 minutes locating an essential item (schedule, aid, registration steps) | **60%** (27% take 10+ min) | Pathify 2025 |
| Prefer one centralized surface over multiple tools and portals | **~75%** (only 12% prefer separate systems) | Pathify 2025 |
| Would be somewhat/very likely to use a unified platform if offered | **95%** | Pathify 2025 |
| Persistent year-over-year friction points | logging in, uploading assignments, finding help, collaborating | EDUCAUSE 2025 |

**Implication:** prefer surfacing what's due and where to go next over teaching students our
navigation. From interviews, the concrete request was a weekly/monthly view of everything
required across all enrolled courses.

## The two principles converge

The professor time sink (36% losing half a workday per week to "when is this due?" / "where is
the assignment?") and the student pain point (47% missing deadlines they didn't know about) are
the same problem viewed from opposite ends.

A clear student-facing "what's due" surface **is** a professor time-saving feature. Worth
remembering when someone argues a student-convenience feature ranks below a professor one.

## Signals we deliberately did not act on

Real findings that don't change a design or code decision, kept here so they don't get
re-litigated: instructor burnout rates (64% at least somewhat burnt out), project-based learning
as the top engagement strategy (74%), demand for automatic advisor notification when a student
disengages (63%), and satisfaction with existing AI authoring tools (96% say they save time).
Useful for positioning and pitch material, not for build decisions.

## Source quality

- **Anthology 2025 Faculty Survey** — n = 2,500+ US-based instructors. **Vendor-sponsored:**
  Anthology owns Blackboard and sells the AI tooling the paper recommends.
- **Pathify 2025 Student Digital Experience Survey** — n = 1,010 US college students, fielded
  September 2025 with Thrive Analytics. **Vendor-sponsored:** Pathify sells a unified campus
  portal, which is precisely what the survey concludes students want.
- **EDUCAUSE 2025 Students and Technology Report** — non-vendor, the neutral corroboration.

Both vendor surveys have a commercial interest in their own conclusions, so treat the exact
percentages as indicative rather than authoritative. What makes them usable is convergence:
three independent sources plus our own interviews point the same direction.

## Sources

- [Addressing the Hidden Crisis: The Realities of Faculty Burnout — Anthology (2025)](https://backstage.anthology.com/sites/default/files/2025-08/AddressingTheHiddenCrisisTheRealitiesOfFacultyBurnout_WhitePaper_v1.pdf)
- [Pathify 2025 Student Digital Experience Survey](https://pathify.com/news/new-survey-finds-fragmented-digital-systems-are-eroding-student-success-belonging-and-satisfaction-across-u-s-colleges-says-pathify/)
- [Pathify survey — PR Newswire release](https://www.prnewswire.com/news-releases/new-survey-finds-fragmented-digital-systems-are-eroding-student-success-belonging-and-satisfaction-across-us-colleges-says-pathify-302637289.html)
- [2025 EDUCAUSE Students and Technology Report](https://library.educause.edu/resources/2025/4/2025-educause-students-and-technology-report)
- [CUPA-HR 2025 Higher Education Employee Retention Survey](https://www.cupahr.org/resource/higher-ed-employee-retention-survey-findings-september-2025/)

_Last updated: 2026-07-27. Refresh when the 2026 survey cycle publishes._
