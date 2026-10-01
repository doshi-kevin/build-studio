# Athena — What the AI Assistant Can Actually Do

Athena is Scholera's single AI identity, built on Google Gemini. It isn't one chatbot — it's one shared engine that shows up as three different surfaces depending on who's using it and what screen they're on, plus a handful of AI features elsewhere in the product that run on the same infrastructure without being branded "Athena." This document lists what Athena (and those adjacent AI features) can do, feature by feature, so you know exactly what capability exists where. For the product-level feature tour, see [FEATURES.md](./FEATURES.md); for how course knowledge is stored and searched, see [MEMORY-LAYER.md](./MEMORY-LAYER.md).

**The one rule that holds everywhere:** Athena can look things up and can draft things, but it cannot save a grade, publish content, or send anything to a student on its own. A person always takes the final action.

## How the three surfaces are told apart

One shared "core" runs every Athena turn: it calls Gemini, shows a live "Looking things up…" activity feed while it works, tracks the cost of every single call (even ones that don't get saved) against a billing ledger, and scrubs anything from the visible answer that was actually an internal app-navigation instruction rather than text meant for the reader. That last part matters — if a tool decides to jump the user to a specific page or pre-fill a box, that decision is made by the tool's own server code, never by the model itself, and it's only revealed after the model has finished answering. This means there's no way for a cleverly worded question to trick Athena into navigating somewhere or filling something in that wasn't actually decided by trusted code.

Every Athena capability, and every other AI feature in the product, belongs to one of nine named groups. Scholera's own staff can turn a group off for the whole platform, a school's admin can turn it off just for their school, and in some cases a course-level setting decides whether students can reach it. Whichever level says "off" wins, and if the system can't even confirm the setting, it treats the feature as off rather than risk running an AI call it shouldn't — so a technical hiccup never accidentally leaves something on. See FEATURES.md for the plain-English version of this.

---

## 1. Professor Console — the standalone Athena chat

This is the always-available chat a professor opens on its own, not tied to any one editor. Almost everything it does falls into one of two buckets:

**It drafts content, never publishes it.** Every content-creating capability below hands back an editable card; nothing is written to the database until the professor clicks Approve. The AI literally has no code path to save these on its own — approval routes through the exact same authorized action a professor's own click would use.

- **Draft an announcement** — writes the title and body for a class-wide announcement.
- **Draft a reply** — writes a reply to a specific student's message.
- **Draft discussion prompts** — open-ended, ungraded questions with no answer key.
- **Draft a module outline** — a lesson/unit plan that becomes an unpublished module once approved.
- **Draft a project brief** — guidelines, team size, and a due date for a team or individual project.
- **Draft an assignment** — a full gradable assignment, created unpublished.
- **Draft a Challenge Board task** — an optional, points-bearing gamified challenge.
- **Draft a rubric** — grading criteria and performance levels for an existing project (never assigns an actual score).
- **Draft feedback for a named student** — qualitative comments only; explicitly barred from ever writing a numeric or letter grade.
- **Rewrite for accessibility** — takes a piece of text and produces a simplified, ESL-friendly, or advanced version.

**It reads real course data, on request:**
- Pulls the latest finished live-class quiz report (per-concept accuracy, who didn't answer).
- Answers "how's the course doing" questions using real numbers (modules/quizzes published vs. still drafts, class average, which students are flagged at-risk).
- Looks up one named student's grades, how they compare to the class average, and their trend over time.

**It can remember a stated preference** — a professor (not a TA) can tell Athena something to keep in mind for future conversations; only the professor who set it can see or delete it later.

## 2. Authoring Dock — the Athena panel embedded in an editor

This is the small Athena panel that lives inside whatever a professor is actively building. It's aware of exactly which screen it's on and only gets the tools relevant to that screen — the About-page dock literally has no access to quiz-generation tools, and vice versa. There are seven such screens today: **file-upload assignments, notebook assignments, verbal (spoken) assignments, document assignments, the Quiz Studio, the course About page, and Projects.**

The dock's write capability always works the same way: it fills in the on-screen draft directly (so the professor watches the fields populate live, with the ability to undo), but nothing reaches the database until the professor's own Save runs.

**Per-screen capabilities:**

- **Quiz Studio** — build or edit a quiz's question structure; adjust settings like title, time limit, number of attempts, pass mark, shuffling, and adaptive mode (never publishing, proctoring, or the actual scoring internals); **generate quiz questions straight from the course's uploaded materials**, streamed onto the screen in batches so the professor can start editing the first batch while the rest are still being written, each one citing the specific page it came from; and pull up which concepts the class is currently weakest on, to target new questions at real gaps.
- **Course About page** — fill in page sections (including deriving a full weekly schedule from the section's real due dates and grading-category weights) and read the actual current state of the course (real due dates, weights, office hours, current TA staff) so it can catch and flag the page describing something that no longer matches reality — a "drift check" that reports the mismatch and only fixes it if the professor confirms. Two things are permanently off-limits here by code, not just instruction: the page's pinned hero block can't be removed or reordered, and any image, banner, or attached-file field is never touched — those are shown to the editor only as short-lived secure links, so letting the model echo one back would quietly break the professor's own upload once that link expired. When the page is in preview (not edit) mode, Athena won't attempt to change anything — it just tells the professor to switch to edit mode first.
- **Project detail page** — fill in a project's brief and structure, and read the project's existing phases, rubric rows, and what's already been scored, plus which of the section's assignments/quizzes could be attached to a phase.
- **Document, Verbal, and file-upload assignment authoring** — fill in that assignment type's specific fields (e.g., a verbal assignment's spoken-question setup), and pull up class weak spots and the section's existing assignments for reference.
- **Frontier mode** (an opt-in, deeper-design mode for authoring, only available once an assignment has been saved) — adds a private, professor/staff-only design notebook (the assignment's underlying logic, likely failure modes, what should make a copied answer visibly wrong) that is explicitly never shown to students, and — outside the Quiz Studio — a point-budgeted rubric it can draft directly into the editor.
- **Grading screen** — can summarize a single submission in neutral terms (word count, on-time or late — never a score), with the summary tool double-checking server-side that the submission actually belongs to the professor's own course before it will read anything, and it can draft written feedback into the feedback box (never the score field, which always stays the professor's to fill in).

## 3. Student Tutor — the study-focused assistant

Grounded in the specific course's own uploaded materials and the professor's actual spoken words from finished live classes (see [MEMORY-LAYER.md](./MEMORY-LAYER.md) for how that content is stored and searched). Every turn takes one of three paths, by design:

- If relevant course content is found, Athena answers from it and cites exactly where — "[Lecture Title, page 4]" — so a student can always check the source.
- If the course has real content indexed but none of it actually answers the question, Athena says so honestly rather than guessing or answering from general internet knowledge.
- Only if the course has nothing indexed yet at all will Athena fall back to teaching from general knowledge — because in that one case there's nothing for a wrong answer to contradict.

There's no general web search available to the student tutor at all — everything it can ground an answer in comes from the course itself.

**What it refuses to do:** if a student has a graded quiz currently in progress — in any of their enrolled courses, not just the one they're chatting in — Athena refuses to help at all until that attempt is over. This check looks at the actual state of the attempt (time limit, due date, grace periods) rather than trusting anything the client claims, and if it can't confirm the attempt has actually ended, it treats it as still in progress rather than risk giving help during a live assessment.

**What it can look up about the student themselves:**
- What to study next, and an overall mastery percentage.
- Their own quiz scores and assignment feedback.
- A review of exactly which questions they got right or wrong on a past quiz.
- Things the professor actually said out loud in a finished live class that might not be written down anywhere (a mentioned deadline, what's in scope for an exam, something the professor emphasized).
- A "what you missed" recap of a class session, including how the student personally did compared to the class.

**What it can set in motion for the student (but never finishes for them):**
- Find and recommend the best-matching open Challenge Board task for that student's current strengths, and open it for them.
- Turn something the student got wrong into a well-formed question and pre-fill it into the live classroom's question box for them to actually send.
- Find the professor's next open office-hours slot and pre-fill a booking note built from the student's real weak topics — the student still has to confirm the booking.

**What it can create, that belongs only to the student:**
- Remember something the student tells it (a preference, what they're working on), always available.
- Leave a study artifact on their personal roadmap — see the artifact kinds below.
- Map out a "what do I need to know first" prerequisite path toward a concept, built only from real topics that actually exist on that course's roadmap — the AI proposes a path, but a fake or hallucinated concept never survives to be shown, because each stop is checked against the real roadmap before display.

**Study artifacts Athena can leave on a student's roadmap:**
- **Flashcards** — front/back cards, each optionally citing its source page.
- **Practice questions** — multiple-choice with an explanation, cited.
- **A checklist** — an ordered study plan with a time estimate per step, which the student can check off.
- **A study guide** — organized notes with headings and bullet points, optionally cited.
- **A knowledge map** — the prerequisite path described above, annotated with the student's own mastery on each stop.

A student can archive any of these without deleting it, so their roadmap doesn't get cluttered with old study aids.

## 4. Other AI features that run on the same engine, without the Athena name

These aren't badged "Athena" in the product, but they run on the same Gemini infrastructure, the same cost tracking, and the same on/off switches:

- **Live in-class instant quiz** — while a class is running, a professor can generate a short quiz on the spot, built from the current slide, what's actually been said so far in the live transcript, and the course's tracked topics, so the questions map cleanly onto the same mastery tracking as everything else. It won't run with no active slide or no transcript yet.
- **Post-class Session Report and Class Insights ("Catch Me Up")** — the factual numbers (who attended, per-concept accuracy, who didn't answer) are computed the moment a class ends, with no AI involved and no wait. A slower AI layer then generates a plain-language summary, flashcards, and a short practice quiz from that specific session's content, and fills into the student's "Catch Me Up" view once ready. A session where nothing was actually said or shown skips the AI step entirely rather than spend money generating insights from nothing.
- **Pre-Class Primer** — a short AI-narrated audio preview of an upcoming lecture. It's generated once per lecture and reused — it only regenerates if the underlying material actually changed, so a professor opening it repeatedly doesn't quietly rack up AI cost.
- **Quiz bank generation with citations** — the same generation engine behind the Quiz Studio dock's question-writing tool, described above.
- **Assignment AI grading** — a two-step process per rubric criterion. First, a cheap, non-AI similarity check: if a student's answer is textually close enough to a reference answer and hits the required keywords, it's ticked automatically with a short note, at no AI cost. Only the genuinely uncertain criteria get sent to Gemini for a real review, and when the model wants to overturn an automatic rejection, it has to quote the exact evidence from the student's own submission — if that quote can't actually be found verbatim in the submission, the case is automatically flagged for the professor to double-check by hand rather than trusted. This entire pipeline only ever produces a *suggestion*; the professor reviews and commits every grade themselves, and every correction they make feeds back into how the AI grades that assignment going forward (see [RECENT-CHANGES.md](./RECENT-CHANGES.md) for the "calibration flywheel" this became in September).

## What Athena is explicitly barred from doing, by code rather than by instruction

These aren't just prompt guidance — they're structural limits the code enforces regardless of what a user asks:

- No draft tool anywhere can save, publish, or send anything — every one of them requires a human's approval click, which is what actually triggers the real, independently-authorized action.
- No student-tutor tool can ever accept a database ID as an input — every identifier it uses comes from the student's own verified session, never from anything the chat conversation could contain. This makes it structurally impossible for a cleverly worded chat message to make Athena look up or act on someone else's data.
- The About page's hero section and any image/file/banner field are unreachable from Athena's editing tools, full stop.
- The grading screen's Athena can write feedback text but has no code path to write an actual grade value.
- The student tutor has no web-search tool — it can only ground answers in the specific course's own materials.
- Athena refuses outright, not just cautiously, to help a student while they're sitting a live graded quiz attempt, anywhere in their enrolled courses.
