# The Memory Layer — How a Course "Learns" Over Time

This explains how Scholera builds up and organizes what it "knows" about a course — the pipeline that turns an uploaded lecture into searchable knowledge, tracks what the class actually understands, and keeps every one of those things walled off to the right course. See [ATHENA.md](./ATHENA.md) for how the AI assistant uses this, and [FEATURES.md](./FEATURES.md) for the product-level picture.

There are two separate kinds of "memory" in Scholera, and they should not be confused:

1. **Course-content memory** — what the course materials say, what's searchable, and what the class collectively knows. This section is about this one.
2. **Athena's personal memory of a student or professor** — things Athena has been told directly ("I have an extended deadline," "I'm working on the neural-nets assignment"). This is a much newer, narrower feature covered at the end of this document.

## 1. From an uploaded file to structured knowledge (extraction)

When a professor uploads a lecture file — a PDF, a PowerPoint, a Word doc, a spreadsheet, an image, or plain text — the system doesn't do anything with it immediately in the request. It queues a background job and a worker picks it up shortly after, so an upload never makes the professor wait.

The worker reads the file in two tiers:

- **Tier 0 — deterministic, essentially free.** It pulls text per page directly from the file, along with embedded images, and (for PowerPoint) formulas that are already encoded as real math markup in the file, plus tables it can detect from their own grid structure.
- **Tier 1 — AI vision, used selectively.** Some pages need more than that: a scanned page with barely any extractable text, or a page whose content looks mathematical. Those specific pages get rendered as images and sent to a vision model, which reads them the way a person would and returns the formulas, figure descriptions, or a reconstructed table for anything too irregular for the deterministic pass to parse (a merged cell, a borderless layout). There are hard size and page-count caps so an oversized file can't run up an unbounded AI bill — it just skips the vision step past those caps.

What comes out gets stored on the material itself: the text of every page, the images, formulas and tables, per-section progress markers the UI uses to show "still processing," a short one-paragraph summary of the whole document, and — the most important output — a ranked list of the **concepts** the material actually teaches, each tied back to the specific page it appears on. A cleanup pass throws out anything that isn't really a concept: course-logistics headers, "Grading Policy," AI-generated slide-title noise. This concept list is what everything downstream is built from — quiz generation, the skill map, and the AI tutor's citations.

If a professor re-uploads or replaces a file, the system checks whether a newer version has since taken over before writing anything, so a slow, stale processing job can never clobber a fresher one — and it also can't get stuck forever pointing at a version that no longer exists.

## 2. Making it searchable (vectors)

Extraction produces text and structure; a separate step turns that into something an AI tutor can actually search by meaning rather than exact keyword match. Each page of a material becomes one entry in a search index (Pinecone), built with a specific AI embedding model that turns text into a list of numbers representing its meaning. A live lecture's transcript goes through the same process, chunked by spoken segment instead of by page, and lands in the exact same search pool — tagged so the system can tell "this came from a slide" apart from "this came from what the professor said out loud," but a student's question can be answered from either.

Critically, the **actual text is not stored in the search index at all** — only an id pointing back to the real record in the main database, plus a page number and a content-type tag. When someone actually asks a question, the system finds the best-matching ids and then looks up the real text from the main database at that moment. This matters for two reasons: the main database's permission rules still apply to that final lookup (a stale search match can never bypass who's allowed to see what), and it means if a professor turns a feature off or un-publishes something, that takes effect immediately — there's no separate copy sitting in the search index that would need to be found and deleted too.

Uploading, re-uploading, and deleting a material all trigger the same background job, which doesn't try to calculate a precise "diff" of what changed — it just looks at the material's current state and makes the search index match it. Unchanged pages are skipped (so editing one page of a long document doesn't re-process the whole thing), and pages that got deleted (e.g. a shorter replacement file) get cleaned out. This makes the whole thing safe to retry: if a job fails partway through, running it again just picks up where it left off instead of duplicating anything.

## 3. What the class actually knows (Skills / Topic Mastery)

Every course section has its own list of **skills** — the actual concepts being taught, with some organized as a sub-skill under a broader one (e.g. "Backpropagation" under "Neural Networks"). This list isn't typed in by the professor from scratch; it's assembled automatically from several sources feeding into one shared, de-duplicated pool:

- Concepts pulled from uploaded lecture materials (see above)
- Tags a professor or TA puts on individual quiz/exam questions
- Tags on live in-class quiz questions (the quiz's title itself is deliberately ignored here — titles are summaries, not concepts, and using them would pollute the list with junk)
- Concepts pulled from an assignment's own text (its instructions, guidelines, rubric)

Because different sources describe the same idea differently ("Backprop" vs. "Backpropagation" vs. "back-propagation"), a matching step collapses near-duplicates into one entry rather than creating three separate skills for the same thing.

A brand-new concept doesn't show up to students right away — it starts as a private "suggestion" and only becomes a real, scored skill once it's been **corroborated**: it shows up in more than one material, or it's tied to something actually graded. This keeps a one-off typo or an odd AI extraction from becoming a permanent, wrong entry in the course's skill list. Once a skill is confirmed, the system never quietly removes it again.

**How a student's mastery score is calculated:** every time something is graded — a quiz, an assignment, a small roadmap comprehension check, an approved challenge — that student's score for the relevant skill(s) updates immediately. Separately, the whole section's mastery data gets fully recalculated from scratch on a schedule (a five-minute sweep plus a nightly overnight run), replaying every graded thing that ever happened in order. Both paths use the exact same math, so they're guaranteed to agree — the nightly full rebuild exists specifically as a safety net in case something in between was missed.

Every student's mastery on a skill lands in one of three bands: **Weak** (below 60), **Shaky** (60-79), or **Strong** (80-100). This lets a student see exactly which specific ideas they're behind on, not just an overall grade.

## 4. How memory stays separated between courses and schools

This is the part worth being precise about, because getting it wrong would mean one professor's students or materials leaking into another's:

- **Everything is scoped to one course section** — one professor's one offering of a course in one semester — not to the course in general and not to the whole school. A material's extracted content, its search-index entries, the skill list, and the mastery scores are all tied to that one section's id.
- **The search index's separation is a single function, used everywhere.** Every search query and every write is built from an institution id and a section id, never from a raw string someone could tamper with. This is the entire security boundary for the search index, since it doesn't have its own permission system the way the main database does.
- **No sharing across institutions, anywhere, for anything.** There's no path in the system that lets one school's data reach another school's course.
- **One narrow, deliberate exception:** when a professor teaches the same course again in a new semester, they can publish a confirmed skill to a shared library for that course, which then seeds a brand-new (empty) section's skill list so it doesn't start from zero. This only ever fires for an empty new section, only ever copies skill *names* (never mastery scores, never materials, never search-index content), and only ever moves between two sections of the *same course* at the *same school*.

## 5. What's permanent vs. what's a rebuildable cache

The main database (Postgres) is the one place nothing can be lost. Everything else described above — the search index, the extracted content, the skill mastery scores — is treated as a cache that can, in principle, be wiped and rebuilt from the main database without losing anything real, because the underlying graded work, uploaded files, and question tags all live there permanently. In practice this means a bug in the search index or the mastery numbers is a "rebuild it" problem, not a "we lost data" problem.

## 6. Athena's memory of a person (a different, newer thing)

Separately from all of the above, Athena can now remember specific things a student or professor has explicitly told it — for example, that a student has an agreed extended deadline, or which assignment they're currently focused on. This is intentionally narrow: the system is built to keep the *fact* ("extended deadline granted") without keeping the *reason* a student gave for it, so a sensitive personal or medical explanation is never stored. This shipped alongside a dedicated security review that found and fixed real issues (a case where the system was silently deleting a preference it should have kept, and a bug where a safety catch was accidentally logging the very information it was meant to protect) — see [RECENT-CHANGES.md](./RECENT-CHANGES.md) for the timeline.

This is separate from ordinary conversation history: reopening a past Athena conversation just replays that conversation's own messages back — there is no summarization that carries facts from one conversation into an unrelated one. The "memory" feature described in this section is the one deliberate exception, and only for the specific facts it's designed to retain.

## Known gaps for a future pass

- The live-quiz-generation-from-a-running-transcript code path (turning what's being said in class into a quiz question in real time) wasn't traced in full detail in this pass — only how the transcript gets stored and made searchable afterward.
- The course-to-course skill library (item 4's one exception) wasn't read in full depth beyond confirming its boundaries.
