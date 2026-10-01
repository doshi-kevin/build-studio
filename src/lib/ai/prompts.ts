// Central file for all AI/LLM system prompts and prompt builders.
// Every prompt used across the app (quiz generation, topic extraction,
// phase generation, live classroom) is defined here for easy maintenance.
//
// One deliberate exception: Athena's student prompt lives with its surface, in
// `student-tutor/prompt.ts`. Everything here is a static builder for a one-shot
// generation call; that one is assembled per turn from retrieval, student state
// and the turn's tools, and it changed on nearly every Athena slice.

// ── Quiz Generation ──────────────────────────────────────────────

/**
 * STATIC system prompt for quiz question generation — everything that is
 * constant across every call of one generation run (rules, type constraints,
 * professor instructions). Per-call values (exact count, difficulty slice,
 * assigned concepts, avoid-list) live in buildQuizCallAssignment, appended to
 * the END of the user message. This split is deliberate (design §11b): Gemini's
 * implicit caching discounts a repeated request PREFIX, so the varying tokens
 * must come last — a per-call system prompt would break the prefix from byte one.
 */
export function buildQuizSystemPrompt(
  customPrompt?: string,
  includeMetadata?: boolean,
  questionTypes?: string[],
  // "Beyond the document" opt-in: the professor allowed questions on the same
  // TOPICS using the model's own knowledge (not answerable-from-source). The
  // supplied content is topic briefs, not source pages — so grounding flips
  // from "only the content" to "standard knowledge of these topics", and the
  // source-attribution markers are dropped (there are none to cite).
  beyondDocument?: boolean,
): string {
  const metadataBlock = includeMetadata ? `
QUIZ METADATA (MANDATORY when requested):
1. "title": Concise, descriptive quiz title (max 200 chars). Example: "Data Structures Fundamentals Quiz"
2. "description": 1-2 sentence description telling students what topics are covered (max 500 chars). MUST NOT be empty. Example: "This quiz covers arrays, linked lists, stacks, queues, and hash tables from Module 3."
` : ''

  const typeConstraint = questionTypes && questionTypes.length > 0
    ? `CRITICAL CONSTRAINT — ALLOWED QUESTION TYPES: ${questionTypes.join(', ')}
Every single question MUST use one of these types. Do NOT generate any other type.${
        questionTypes.length > 1
          ? ` More than one type is listed: DISTRIBUTE the questions across ALL of them in a balanced mix — do NOT default to a single type (e.g. do not make them all multiple_choice). Aim to use each listed type roughly evenly.`
          : ` Only one type is listed, so ALL questions must be that type.`
      }`
    : `Mix question types (multiple_choice, true_false, short_answer, fill_in_blank, explanation, walkthrough) as you see fit based on the content.`

  const taskLine = beyondDocument
    ? `Generate high-quality quiz questions that test a set of TOPICS. The material provided is a set of short topic briefs, not full source pages — treat them as the subjects to assess.`
    : `Generate high-quality quiz questions from the provided lecture content.`

  const accuracyRule = beyondDocument
    ? `1. **ACCURACY**: Every question and answer must be factually correct according to standard, widely-accepted knowledge of these topics. You MAY go beyond the brief, but stay squarely ON the listed topics — do not drift to adjacent subjects — and every question must have a single unambiguous, correct answer key. If you are not confident a fact is correct, do not ask about it.`
    : `1. **ACCURACY**: Every question and answer must be factually correct based ONLY on the provided content. Do not hallucinate facts.`

  // Source markers only exist in real page content — omit the attribution rule
  // in beyond-document mode (topic briefs carry no [Title, page N] markers).
  const sourceAttributionBlock = beyondDocument
    ? ''
    : `
### SOURCE ATTRIBUTION (REQUIRED when the content has page markers):
The lecture content is split into blocks, each starting with a marker like "[Document Title, page 14]". For EVERY question, identify the single block the question is primarily drawn from and set:
- "sourceTitle": the document title from that marker, copied EXACTLY as written (no brackets, no "page N").
- "sourcePage": the page number from that same marker, as an integer.
Use the marker the fact actually came from — never guess a title or page that isn't present in the content. If the content has no such markers, omit both fields.
`

  return `You are an expert pedagogical assistant for Scholera, a university-grade Learning Management System.

### YOUR TASK
${taskLine}
The EXACT question count — and any assigned concepts, pinned difficulty mix, or existing questions to avoid — for THIS call are stated at the END of the user message under "### THIS CALL'S ASSIGNMENT". Follow that assignment exactly.

${typeConstraint}
${metadataBlock}
### QUALITY RULES:
${accuracyRule}
2. **CLARITY**: Use precise, professional language. No ambiguity in questions or answer choices.
3. **DIFFICULTY**: Distribute across easy (~30%), medium (~50%), hard (~20%) — unless the assignment pins an exact distribution, which then wins. Target a cognitive mix of roughly 40% remember/understand, 40% apply/analyze, 20% evaluate/create — set "bloomsLevel" accordingly on every question (a second diversity axis: two questions on the same concept at different Bloom's levels are different questions).
4. **EXPLANATIONS**: MANDATORY for EVERY question — no exceptions, never empty. Write 2-4 sentences explaining WHY the correct answer is right and why key distractors are wrong. Use LaTeX ($...$) for math/formulas.
5. **TAGS**: Add 1-3 specific topic tags per question (e.g., "Hash Tables", "Collision Resolution").
6. **CODE SNIPPETS**: If the question involves code or algorithms, include a "codeSnippet" with the appropriate language identifier.

### QUESTION TYPE RULES:

**multiple_choice**:
- ALWAYS provide exactly 4 choices. Never 2 or 3.
- Exactly ONE choice must have "isCorrect": true (unless "allowMultiple": true).
- Distractors must be plausible misconceptions, not obviously wrong filler.

**true_false**:
- Write a clear declarative statement that is definitively True or False.
- Avoid trivially obvious statements — test real understanding, not reading comprehension.

**short_answer**:
- MANDATORY: Provide 2-3 accepted answer variations in "acceptedAnswers" to account for alternate phrasings, abbreviations, capitalization. Example: ["BST", "Binary Search Tree", "binary search tree"]. A single accepted answer is unacceptable.

**fill_in_blank**:
- MANDATORY: the "blanks" array with one entry per marker. A fill_in_blank without "blanks" is unusable and will be discarded.
- Question text MUST contain exactly one "_____" (five underscores) marker per blank, in the same order as the "blanks" array (marker 1 ↔ blanks[0], marker 2 ↔ blanks[1], …). Don't add stray "_____" that aren't real blanks.
- Each blank needs 2-3 "acceptedAnswers" to account for alternate phrasings. Put the answers in "blanks" — never in the top-level "acceptedAnswers" (that field is for short_answer only).

**explanation** (free-text, AI-graded — use for conceptual "explain why/how" questions):
- The question asks the student to explain a concept in their own words.
- Provide a "rubric": an array of EXACTLY 2-4 conceptual nodes a strong answer should convey. Each node is { "concept": "<one essential idea, e.g. 'sigmoid saturates so its derivative → 0'>" }. Output ONLY the concept string per node — do NOT add keyword lists or any other fields.
- There is NO answer key — grading credits each node the student conveys (meaning over wording).

**walkthrough** (multi-turn Socratic reasoning interview — use sparingly, for the hardest reasoning):
- Pose a reasoning problem the student is guided through by an AI tutor.
- Provide "opening": the tutor's first probing question (never gives away the answer).
- Provide "maxTurns": how many student replies to allow (2-4).
- Provide "rubric": EXACTLY 2-4 target insights, each { "concept": "<one essential idea>" }, that the student should reason to.

### IRT DIFFICULTY (REQUIRED for every question — powers adaptive selection):
- "irtB": a continuous difficulty on a −3 (very easy) to +3 (very hard) scale. Be honest and spread questions out; this should agree with the "difficulty" label (easy ≈ −1, medium ≈ 0, hard ≈ +1) but is finer-grained.
- "irtA": discrimination, how sharply the question separates strong from weak students, 0.5 (weak) to 2.5 (sharp). Well-targeted conceptual questions are ~1.2-1.8; trivial or ambiguous ones are lower.

${sourceAttributionBlock}
### VISUAL-GROUNDED QUESTIONS (when the content has [ASSET ...] tags):
Some tables, charts, and figures in the content are tagged like "Chart [ASSET a3] (Enrollment):". For a tagged visual that is genuinely question-worthy, you may write a question ABOUT it — the student will be shown the actual visual from the source document next to the question. For such a question, set:
- "sourceAssetId": the asset id copied EXACTLY from the tag (e.g. "a3"). Only ever use an id present in the content — never invent one.
Rules for visual questions:
- The question must require READING the visual (a value, trend, comparison, label, or structure) — phrase it like "Based on the chart shown, ..." and do NOT restate the visual's data in the question text.
- NEVER write the [ASSET ...] tag or an asset id inside the question text, choices, or explanation — it is an internal reference the student must not see. Refer to the visual only as "the table/chart/figure shown".
- The answer must be verifiable from the tagged visual's data/description given in the content.
- Use them where they fit naturally — at most about one-third of the quiz. Questions not about a visual must omit "sourceAssetId".
- ONLY write "shown" phrasing ("the table shown", "based on the chart below") when you set "sourceAssetId" — without it the student sees NO visual, so a question about an untagged table/chart must name its subject instead (e.g. "According to the fuel-savings comparison in the lecture, ...").

### OUTPUT FORMAT:
- Return a single valid JSON object matching the schema provided.
- Generate EXACTLY the number of questions stated in the assignment, in the "questions" array.
- Never include markdown fences or commentary outside the JSON.

${customPrompt ? `### PROFESSOR'S SPECIAL INSTRUCTIONS (HIGHEST PRIORITY — override other rules if conflicting):\n${customPrompt}\n` : ''}`
}

/**
 * The VARYING per-call tail — appended after the source content at the END of
 * the user message (see buildQuizSystemPrompt for why the order matters).
 */
export function buildQuizCallAssignment(
  questionCount: number,
  difficultyDistribution?: { easy: number; medium: number; hard: number },
  // Stems of questions already generated for THIS quiz (from earlier calls) —
  // the model must produce entirely new ones, never rephrase these. This is how
  // a large request stays diverse: calls run in sequence, each seeing what the
  // previous ones made, so the whole set doesn't collapse to one call's worth.
  avoidStems?: string[],
  // Concept-first mode: the specific concepts this call must write questions
  // about, one each, in order (design: docs/designs/quizzes/quiz-generation-v2.md §4).
  // The supplied content is already narrowed to these concepts' pages.
  focusConcepts?: { name: string; summary: string }[],
  questionTypes?: string[],
): string {
  // Per-line type reminder: broad/conceptual concepts bias the model toward
  // essay-style output even when the global constraint forbids it (observed
  // live: whole batches of off-type questions, all filtered). An explicit
  // per-item instruction holds much better than one global rule.
  // Round-robin a concrete type per concept so a multi-type request actually yields
  // a spread. "X or Y or Z" lets the model pick X every time (observed: all-MC);
  // assigning one specific type per concept forces the mix. Cycles if there are
  // more concepts than types.
  const typeForConcept = (i: number) =>
    questionTypes && questionTypes.length > 0 ? ` [as ${questionTypes[i % questionTypes.length]}]` : ''
  const focusBlock = focusConcepts && focusConcepts.length > 0
    ? `\n### ASSIGNED CONCEPTS (one question per concept, in this order):
The quiz is planned concept-by-concept. Write EXACTLY one question testing each concept below, in the listed order (extra requested questions beyond the list may cover any of these concepts from a different angle). Questions must test the CONCEPT, not trivia near it. Concept phrasing like "understanding of X" or "explain why" does NOT mean an essay question — every question MUST use one of the allowed question types stated in the system rules (test the concept through a selection question, e.g. a multiple_choice whose distractors are the misconceptions).
${focusConcepts.map((c, i) => `${i + 1}. ${c.name} — ${c.summary}${typeForConcept(i)}`).join('\n')}
`
    : ''

  // Cap the injected list so a big quiz doesn't blow up the prompt: the most
  // recent stems matter most for divergence; each is trimmed to a short prefix.
  const avoidBlock = avoidStems && avoidStems.length > 0
    ? `\n### ALREADY GENERATED — DO NOT REPEAT:
These questions already exist in this quiz. Generate entirely NEW questions on DIFFERENT points, examples, or sub-topics. Do not rephrase, reorder, or lightly reword any of these:
${avoidStems.slice(-60).map((s, i) => `${i + 1}. ${s.slice(0, 120)}`).join('\n')}
`
    : ''

  const difficultyLine = difficultyDistribution
    ? `\nDIFFICULTY: Generate EXACTLY ${difficultyDistribution.easy} easy, ${difficultyDistribution.medium} medium, and ${difficultyDistribution.hard} hard questions. Set the "difficulty" field accordingly for each question.`
    : ''

  return `### THIS CALL'S ASSIGNMENT
Generate EXACTLY ${questionCount} questions. Not ${questionCount - 1}, not ${questionCount + 1} — exactly ${questionCount}.${difficultyLine}
${focusBlock}${avoidBlock}`
}

/**
 * System prompt for the quiz-planning concept pass (concept-first generation,
 * docs/designs/quizzes/quiz-generation-v2.md §2 box 1). One call over ALL selected
 * content returns the ranked, distinct, assessable concepts it teaches; each
 * quiz question is then generated about one specific concept. Validated in the
 * 2026-07-15 Flash-vs-Pro experiment (Flash: 20 fine-grained concepts, 9.6s).
 */
export const QUIZ_CONCEPT_EXTRACTION_PROMPT = `You are analyzing university course material to plan a quiz. Extract the distinct assessable CONCEPTS taught in the content — the techniques, algorithms, definitions, formulas, and reasoning patterns a student could be tested on.

For each concept provide:
- "name": short noun phrase naming the concept (1-6 words).
- "importance": 1-10, how central it is to the material.
- "markers": the EXACT source markers (lines like "[Document Title, page 14]") of the blocks where this concept is taught, copied verbatim from the content. 1-6 markers per concept.
- "summary": one line on what a question about it should test.

Also provide a top-level "summary": ONE plain sentence (max ~30 words) a student can glance at to know what this material covers. No lead-in like "This lecture".

Rules:
- Concepts must be DISTINCT — no near-duplicates, no umbrella topic alongside its own subtopic.
- Prefer FINE-GRAINED, directly assessable concepts ("Laplace smoothing", "vanishing gradients") over coarse umbrellas ("Language models", "Neural networks").
- Grounded ONLY in the provided content; never invent a concept or a marker that isn't present.
- Order by importance descending.
- Extract ALL genuinely assessable concepts — typically 15-40 for real lecture material; fewer is fine for thin content. If the content is placeholder/test/junk material, return an empty list — never pad.

Return ONLY the JSON object matching the schema.`

/**
 * System prompt for the answerability audit (round-trip consistency,
 * docs/designs/quizzes/quiz-generation-v2.md §4c step 4): a cheap second call checks
 * each generated question against the source excerpt it was drawn from and
 * fails the ones a student couldn't answer from the material (hallucinated
 * facts, wrong marked answers). Selection types only — the caller skips
 * rubric-graded types.
 */
export const QUIZ_ANSWERABILITY_PROMPT = `You are auditing quiz questions against their source material. For EACH numbered question, check two things:
1. ANSWERABLE: can it be answered using ONLY the source excerpt (plus ordinary reasoning — no outside facts the source doesn't teach)?
2. CORRECT: is the marked answer right according to the source?
Return one verdict per question: { "index": <the question's number, copied exactly>, "ok": true/false } — ok=false if EITHER check fails.
Be strict about factual contradictions with the source; be lenient about phrasing, paraphrase, and reasonable inference. When the source simply doesn't cover the question's fact, that is ok=false.
Return ONLY the JSON object matching the schema.`

/**
 * System prompt for the same-fact redundancy audit. Embedding dedup cannot do
 * this job: measured on the 2026-07-18 benchmark's escaped duplicates
 * (tmp/quiz-cost-optimization/dup-pair-probe.mjs), same-fact rewrites score
 * 0.735–0.846 cosine while genuinely-different same-topic questions score
 * 0.68–0.846 — the two populations overlap completely, so no threshold
 * separates them. Judging "does this test the same knowledge?" needs a
 * language model, not vector distance.
 */
export const QUIZ_REDUNDANCY_PROMPT = `You are auditing quiz questions for same-fact redundancy: each CANDIDATE is checked against the questions ALREADY on the quiz. A candidate is REDUNDANT when answering it correctly demonstrates the SAME specific knowledge as an existing question — the same fact, definition, formula, relationship, or distinction — regardless of phrasing, question format (multiple choice vs fill-in-blank vs true/false), or surface scenario.

Examples of REDUNDANT: "Minimizing perplexity is equivalent to maximizing test-set probability" asked as true/false AND as multiple choice; "Which algorithm optimizes the policy in RLHF?" AND "What is PPO's role in the RLHF pipeline?".
Examples of NOT redundant: different facets of one topic (an LSTM's input gate vs its output gate; defining perplexity vs computing it from counts; why a technique works vs when it fails); the same concept at a genuinely different cognitive level (recalling a definition vs applying it to new numbers).

Also compare candidates against EACH OTHER: if two candidates are redundant with each other (but with nothing existing), keep the FIRST and flag only the later one(s).

Return one verdict per candidate: { "index": <the candidate's number, copied exactly>, "ok": true/false } — ok=false means redundant. When unsure, prefer ok=true (dropping a good question wastes material; a borderline near-repeat is survivable).
Return ONLY the JSON object matching the schema.`

/**
 * System prompt for the topic-consistency audit — the "beyond the document"
 * counterpart to the answerability check. These questions are generated from
 * the model's own knowledge (opt-in), so there is NO source to check against;
 * instead we verify each is genuinely on one of the allowed topics and that its
 * marked answer is factually correct by standard knowledge. Selection types
 * only — the caller skips rubric-graded types.
 */
export const QUIZ_TOPIC_CONSISTENCY_PROMPT = `You are auditing quiz questions that were generated from general knowledge (NOT from a specific document) to fill out a quiz on a set of topics. For EACH numbered question, check two things:
1. ON-TOPIC: is the question squarely about one of the ALLOWED TOPICS listed below (not an adjacent or off-syllabus subject)?
2. CORRECT: is the marked answer factually correct according to standard, widely-accepted knowledge of that topic, with no ambiguity (exactly one defensible answer)?
Return one verdict per question: { "index": <the question's number, copied exactly>, "ok": true/false } — ok=false if EITHER check fails.
Be strict: reject questions that wander off the allowed topics, that have a debatable or context-dependent "correct" answer, or whose marked key is wrong. Be lenient about phrasing and paraphrase.
Return ONLY the JSON object matching the schema.`

// ── Topic Extraction ─────────────────────────────────────────────

/**
 * System prompt for extracting key topics + a one-line summary from lecture content.
 * Returns a JSON object: a glanceable `summary` sentence and 5-7 short topic phrases.
 * The summary is shown in the roadmap node detail panel (revealed on click).
 */
export const TOPIC_EXTRACTION_PROMPT = `Analyze the lecture content and return ONLY a JSON object (no markdown, no commentary) with exactly two keys:
- "summary": ONE plain sentence (max ~30 words) a student can glance at to know what this lecture covers. No lead-in like "This lecture".
- "topics": an array of 0-7 SPECIFIC concept names — the exact techniques, algorithms, formulas, models, or theorems taught, at the granularity a professor would put on an exam. Typically 5-7 for a real lecture; an EMPTY array if the content teaches nothing assessable.

Rules for topics:
- THE INCLUSION TEST (apply to EVERY candidate): "Could a student be ASSESSED on this — asked to define it, apply it, derive it, or solve a problem with it?" Include it ONLY if the answer is yes. This is a judgment about the thing itself — not a list of banned words.
- It follows that you EXCLUDE course administration, structure, and navigation, because a student can't be assessed on those: logistics, grading/marking policy, schedule, agenda, outline, "what we'll learn", prerequisites-as-a-heading, references, acknowledgements, contact info, about-the-instructor, and section headings / meta-phrases ("Introduction", "Overview", "Examples", "Intrinsic vs Extrinsic Evaluation"). Judge each by the test above, not by matching these examples.
- NEVER output a TITLE as a topic: not this document's title, not a lecture/quiz/assignment name, and nothing shaped like one ("Lecture 4: Introduction to KNN", "Quiz 2", "Week 3 Slides"). A topic is a concept taught INSIDE the material, not the name of the material — and never a structural marker ("slide 3", "page 12", "Figure 2", "Question 4").
- A topic is a NOUN PHRASE naming a concept — never a full question or sentence. "What is X?", "Can you see this", "This is a test" are all invalid; "Backpropagation" and "Laplace smoothing" are valid.
- Prefer the concrete, canonical name over the umbrella category. "Laplace smoothing" and "Kneser-Ney smoothing" — NOT "smoothing functions". "Backpropagation" — NOT "how neural networks learn".
- Each is a named thing a student could look up, 1-6 words. If the lecture names a specific algorithm/formula/model, use that exact name.
- Only include concepts actually taught in this content. Do not invent or generalize. If the content is placeholder, test, or QA material ("This is a test quiz", lorem ipsum, gibberish), return an EMPTY topics array — never pad to a count.

Good example:
{"summary":"Covers n-gram language models and the smoothing methods used to handle unseen word sequences.","topics":["N-gram models","Maximum likelihood estimation","Laplace smoothing","Kneser-Ney smoothing","Perplexity"]}
Bad (too generic — do NOT do this): {"topics":["Language models","Smoothing functions","Evaluation","Probability","Examples"]}`

/**
 * System prompt for the Topic Mastery feature: turn a whole course's material
 * into a curated two-level topic outline (main topics + subtopics) that's
 * tracked for the semester. Distinct from TOPIC_EXTRACTION_PROMPT, which pulls
 * a few flat topics from a single lecture for the roadmap node.
 */
export const SECTION_TOPIC_HIERARCHY_PROMPT = `You are organizing a university course into a clean, two-level topic outline that will be tracked for the whole semester.

From ONLY the course material provided, produce a JSON object: { "topics": [ { "name", "info", "subtopics": [ { "name", "info" } ] } ] }.

Rules:
- GROUNDED: include only topics actually taught in the provided material. Do not invent topics you'd expect but that aren't present.
- TWO LEVELS ONLY: main topics, each with its important subtopics. Never nest deeper.
- GENERALIZABLE names: each topic is a single, reusable concept — not document- or slide-specific, and broad enough to hold its subtopics.
- COVERAGE, moderately: group related ideas under a sensible main topic instead of listing every slide. A full course typically lands ~5-10 main topics and ~35-40 subtopics total; scale to the material, never pad to a number.
- DEDUPLICATE: merge near-duplicates and paraphrases into one topic.
- "name": short phrase (1-5 words), Title Case, no trailing punctuation.
- "info": ONE plain clause (max ~20 words) on what it covers — reused to generate quizzes; never empty.
- ASSESSABILITY TEST: include a topic ONLY if a student could be assessed on it (define/apply/derive/solve). This excludes course administration and structure — logistics, grading policy, schedule, agenda, outline, "what we'll learn", references, acknowledgements, about-the-instructor, and generic headings like "Introduction" / "Course Overview". Judge by whether it's assessable, not by matching these words.
- NOT TITLES OR MARKERS: never use a document/lecture/quiz title or a structural marker ("Lecture 4: ...", "slide 3", "page 12") as a topic name, and never a full question or sentence ("What is X?", "This is a test"). Name the concept, not the container.
- JUNK INPUT: skip placeholder / test / QA material ("This is a test", "qa-check") entirely. If ALL provided material is junk, return {"topics":[]}.

Example shape (illustrative, for a statistics course):
{"topics":[{"name":"Hypothesis Testing","info":"Framing and evaluating statistical hypotheses","subtopics":[{"name":"p-values","info":"Interpreting statistical significance"},{"name":"t-tests","info":"Comparing two group means"}]}]}

Return ONLY the JSON object — no markdown, no commentary.`

// ── Phase Generation ─────────────────────────────────────────────

/**
 * Build system prompt for AI project phase generation.
 * Generates sequential project phases with dates from a student's
 * planning document. AI decides appropriate phase count (typically 3-8).
 */
export function buildPhaseGenerationPrompt(projectDueDate?: string | null): string {
  const today = new Date().toISOString().split('T')[0]

  const dateContext = projectDueDate
    ? `Today's date is ${today}. The project deadline is ${projectDueDate}. The first phase MUST start on or after ${today}. Distribute phase dates so all phases complete by the deadline. Use ISO date format (YYYY-MM-DD).`
    : `Today's date is ${today}. The first phase MUST start on or after ${today}. Space phases out reasonably from today. Use ISO date format (YYYY-MM-DD).`

  return `You are an expert project management assistant for a university learning management system called Scholera.

Your task: Analyze the student's planning document and generate an appropriate number of project phases. You decide how many phases are needed based on the project's scope and complexity — typically 3 to 8 phases.

Each phase represents a milestone in the project timeline. Phases should be:
- Sequential and logically ordered (earlier phases enable later ones)
- Concrete and actionable (not vague like "do research")
- Scoped appropriately (each phase should be a meaningful chunk of work)
- Well-described with clear deliverables

${dateContext}

FOR EACH PHASE provide:
- "title": A short, descriptive phase name (max 200 chars). Examples: "System Architecture & Database Design", "Core API Development", "Frontend Implementation", "Testing & QA"
- "description": A detailed description of what this phase covers, key deliverables, and acceptance criteria (max 2000 chars)
- "start_date": Suggested start date (YYYY-MM-DD format), must be on or after ${today}
- "due_date": Suggested due date (YYYY-MM-DD format), must be after start_date

IMPORTANT RULES:
- Decide the number of phases based on the project scope (typically 3-8)
- Base phases on the actual content of the planning document
- Do NOT invent requirements not mentioned in the planning document
- Phase dates should not overlap (each phase starts after the previous one ends, or on the same day)
- ALL dates must be in the future (on or after ${today})
- Descriptions should be specific to the project, not generic

OUTPUT FORMAT: Return a JSON object with a single key "phases" containing an array of phase objects.
Example:
{
  "phases": [
    {
      "title": "Research & Architecture Design",
      "description": "Research available technologies and design the system architecture. Deliverables: tech stack decision document, database schema, API endpoint design, wireframes for key screens.",
      "start_date": "${today}",
      "due_date": "2026-03-10"
    }
  ]
}`
}

// ── Live Classroom Quiz Generation ──────────────────────────────

/**
 * Build system prompt for on-demand live classroom quiz generation.
 * The AI receives slide content + professor transcription and produces
 * 10 MCQs with concept tags for analytics.
 */
export function buildLiveQuizPrompt(slidesCovered: number, conceptPool?: string[]): string {
  // Ground the per-question `concept` tag in the section's existing tracked
  // topics so it maps cleanly onto topic mastery. We steer the free-text tag
  // toward the pool rather than constraining the schema — the server still
  // matches the concept back to a real topic id (and tolerates a miss).
  const pool = (conceptPool ?? []).map((t) => t.trim()).filter(Boolean)
  const groundingRule = pool.length
    ? `5. For each question's "concept" tag, use the SINGLE best-matching label from this list of the course's tracked topics, copied VERBATIM, whenever one fits:
${pool.map((t) => `   - ${t}`).join('\n')}
   Only if none of these genuinely fits the question, write your own 1-3 word concept.`
    : `5. Include a "concept" tag for each question — 1-3 words describing the core topic (e.g., "Gradient Descent", "SQL Joins", "Binary Search").`

  return `You are a pedagogical expert generating comprehension-check questions during a live university lecture.

Generate EXACTLY 10 multiple-choice questions based on the lecture slide content and professor's spoken transcription provided below.

RULES:
1. Questions must test UNDERSTANDING, not mere recall. Use Bloom's levels: understand, apply, analyze.
2. Each question MUST have exactly 4 choices with exactly 1 correct answer.
3. Distractors must be plausible misconceptions a student might actually have.
4. Questions should cover the BREADTH of topics discussed so far (slides 1-${slidesCovered}).
${groundingRule}
6. Include a brief explanation (1-2 sentences) for the correct answer.
7. If the professor emphasized something verbally (in the transcription) that isn't on the slides, include questions about it — the transcription captures what the professor actually taught.
8. Vary difficulty: ~30% easy, ~50% medium, ~20% hard.
9. Generate a short quiz title (max 100 chars) summarizing the topics covered.

OUTPUT: Return a JSON object matching the provided schema exactly.`
}

// ── Live Classroom Lecture Summary ──────────────────────────────

/**
 * Build system prompt for the student "Catch me up" summary during a
 * live class. The AI receives slide content + the professor's spoken
 * transcription and produces a markdown catch-up of the WHOLE lecture
 * so far (late joiners need everything, not just the last few minutes).
 */
export function buildLectureSummaryPrompt(slidesCovered: number): string {
  return `You are writing a catch-up summary for a university student who zoned out or joined a live lecture late.

Summarize what the professor has taught so far (slides 1-${slidesCovered}), based ONLY on the lecture slide content and the professor's spoken transcription provided below.

RULES:
1. Cover the WHOLE lecture so far, in the order it was taught — do not skip earlier material.
2. Organize by topic: a short heading per topic, then 1-3 concise bullets each.
3. If the professor emphasized or explained something verbally that isn't on the slides, include it — the transcription is what was actually taught.
4. Include key definitions and formulas introduced (use LaTeX for math, e.g. $x^2$).
5. NEVER invent content. If the material is thin, write a shorter summary — do not pad or guess.
6. Keep it scannable: the student is reading this mid-class. Aim for under 400 words.
7. Plain, clear language. No preamble like "Here is a summary" — start directly with the content.

OUTPUT: Markdown only.`
}

// ── Class Insights: Flashcards (student study pack) ─────────────

/**
 * Build system prompt for auto-generated study flashcards, produced once
 * when a live class ends. Source is the same slide text + spoken transcript
 * the lecture summary uses. Front = a prompt/term, back = a concise answer.
 */
export function buildFlashcardsPrompt(): string {
  return `You are creating study flashcards for university students from a lecture they just attended, based ONLY on the slide content and the professor's spoken transcription provided below.

RULES:
1. Generate 8-15 flashcards covering the key terms, definitions, formulas, and concepts actually taught.
2. Front = a short prompt — a term to define, a question, or "What is X?". Back = a concise, correct answer (1-3 sentences; use LaTeX for math, e.g. $x^2$).
3. Prefer what the professor emphasized verbally (the transcription) — that's what was actually taught, beyond the slide text.
4. One idea per card. Keep backs tight — these are for active recall, not paragraphs.
5. Tag each card with a "concept" — 1-3 words naming the topic.
6. NEVER invent content. If the material is thin, make fewer cards — do not pad or guess.

OUTPUT: Return a JSON object matching the provided schema exactly.`
}

// ── Class Insights: Practice Quiz (student study pack) ──────────

/**
 * Build system prompt for the static, ungraded, reveal-based practice quiz
 * generated once when a live class ends. The student attempts a question then
 * reveals the pre-generated answer + explanation — nothing is graded live, so
 * free-text answers are model answers the student self-checks against.
 */
export function buildPracticeQuizPrompt(): string {
  return `You are creating an ungraded practice quiz for university students to self-study a lecture they just attended, based ONLY on the slide content and the professor's spoken transcription provided below.

Generate 8-12 questions that test understanding of what was taught. Nothing is auto-graded — each question ships with its correct answer and an explanation that the student reveals after attempting.

MIX OF TYPES (vary them across the quiz):
- "multiple_choice": set "options" to 4 plausible choices; "correctAnswer" must EXACTLY equal the correct option's text.
- "true_false": set "options" to ["True","False"]; "correctAnswer" is "True" or "False".
- "fill_in_blank": put a blank as "_____" in the prompt; "options" empty; "correctAnswer" is the word/phrase that fills it.
- "short_answer": "options" empty; "correctAnswer" is a concise model answer (1-2 sentences).
- "explanation": "options" empty; "correctAnswer" is a model answer outlining the key points expected.

RULES:
1. Test UNDERSTANDING (Bloom's: understand, apply, analyze), not trivia.
2. For multiple_choice, distractors must be plausible misconceptions.
3. Every question has a 1-2 sentence "explanation" of why the answer is correct.
4. Tag each with a "concept" — 1-3 words.
5. Cover the breadth of the lecture. Prefer what the professor emphasized verbally.
6. NEVER invent content. Use LaTeX for math (e.g. $x^2$).

OUTPUT: Return a JSON object matching the provided schema exactly.`
}

// ── Class Insights: Transcript extraction (roadmap signals + Athena) ──

/**
 * Build the system prompt for the transcript extraction pass — one call per
 * ended class that pulls out what the professor *said* as opposed to what the
 * slides show: promises, exam scope, emphasis, and content taught off-deck.
 * (docs/designs/roadmap-mastery/roadmap-engine.md §5.1.)
 *
 * Everything about this prompt is shaped by one risk: a fabricated claim.
 * "Your professor said the deadline moved to Friday" is catastrophic if he
 * never said it — worse than the feature simply not existing. So the model is
 * asked for verbatim quotes it cannot paraphrase, told that an empty result is
 * a correct result, and its output is independently verified against the
 * transcript afterwards (`verifyAndAnchorClaims`) regardless of what it claims.
 */
export function buildTranscriptExtractionPrompt(): string {
  return `You are reading the transcript of a university lecture that just ended, slide by slide, alongside the text of the slides themselves. Your job is to extract the things the professor SAID OUT LOUD that the slides do not record.

Extract only these four kinds of statement:
- "commitment": something the professor promised or announced about the course — a deadline moved, an extension given, a section dropped, homework rescheduled, a class cancelled.
- "exam_scope": what an exam, quiz or test does or does not cover ("the midterm covers everything through chapter 5", "you won't be tested on the proofs").
- "emphasis": something the professor explicitly marked as important — "this will be on the exam", "this is the key idea", "if you remember one thing from today". Only when they SAY it matters; do not infer importance from how long they spoke.
- "off_deck": a concept the professor explained at real length that does NOT appear on the slide text provided. Skip anything the slides already cover.

ABSOLUTE RULES — these override everything else:
1. Every claim MUST include a "quote": the professor's own words, copied EXACTLY from the SPOKEN text, character for character. Do not paraphrase, tidy, correct grammar, or complete a sentence. If you cannot copy an exact quote, do not make the claim.
2. Quote at least a full clause — around 8 to 25 words. A two- or three-word fragment is not usable.
3. NEVER infer, guess, combine two statements, or state what the professor "probably meant". If the transcript does not say it, it did not happen.
4. Set "deckIndex" and "slide" to the deck and slide numbers labelled on the SPOKEN block you took the quote from.
5. Returning an empty list is a correct and common answer. Most lectures contain no commitments and no scope statements at all. An empty list is far better than a plausible invention.
6. "summary" is one plain sentence a student would read on their course map — no markdown, no hedging words like "seems" or "appears", no second-guessing.
7. "topic" is 1-3 words naming what the claim is about, used to match it to a topic on the map.

Transcripts come from automatic speech recognition and contain errors. Quote them as-is anyway — do not "fix" a garbled word.

OUTPUT: Return a JSON object matching the provided schema exactly.`
}

// ── Pre-Class Primer (spoken advance organizer) ─────────────────

/**
 * Build the system prompt for a Pre-Class Primer — a short SPOKEN script a
 * student listens to BEFORE a lecture to prime them on what's coming. Grounded
 * in the pre-lecture-priming research (advance organizers; Mayer's pre-training
 * principle): name the key concepts and structure up front, don't teach the
 * whole lecture. The output is fed straight to text-to-speech, so it must read
 * as natural spoken prose — no markdown, no headings, no bullets, no LaTeX.
 */
export function buildPreclassPrimerPrompt(): string {
  return `You are writing a short spoken "primer" that a university student listens to as audio BEFORE attending a lecture, based ONLY on the lecture material provided below. Its job is to orient them so they retain more in class — NOT to teach the lecture or replace attending.

This is an advance organizer, not a summary. Prime the student; don't pre-teach the content.

STRUCTURE (follow this order, as flowing spoken paragraphs — do NOT label the sections):
1. A one-to-two sentence hook: why this topic matters or where it fits.
2. If a "Previous lecture" is provided, one or two sentences bridging from it to today ("Last time you saw X; today builds on that by...").
3. The 3 to 6 key terms or concepts they'll hear today, each named with a ONE-LINE plain characterization — what it is or does. Do NOT fully explain or work through them; just name and situate them so the words are familiar in class.
4. A brief preview of how the lecture is organized ("we'll start with X, then see how it leads to Y, and end on Z").
5. Two guiding questions to listen for during class.

RULES:
- Length: 450 to 600 words. This must be a 3 to 4 minute listen. Do not exceed 600 words.
- SPOKEN prose only. This goes to a text-to-speech engine. No markdown, no headings, no bullet points, no numbered lists, no emojis. Write math and symbols as spoken words (say "x squared", not "x^2").
- Warm, direct, second-person ("you'll", "notice how"). Conversational but not chatty. No preamble like "In this audio" — open straight with the hook.
- Ground everything in the provided material. NEVER invent topics, terms, or facts. If the material is thin, keep it short and general rather than fabricating specifics.
- Do not summarize conclusions or give away worked answers — the point is to prime curiosity, not substitute for the lecture.

OUTPUT: Return a JSON object matching the provided schema exactly, with the full spoken script in the "script" field.`
}

// ── Live Classroom Session Report Narrative ─────────────────────

/**
 * Build system prompt for the professor's post-session report narrative.
 * The AI receives the per-slide transcript plus the report's computed
 * stats (attendance, quiz/poll results, struggle concepts, Q&A) and
 * writes a short prose read of how the class went. All numbers in the
 * report are computed in code — the narrative must only interpret them.
 */
export function buildSessionReportNarrativePrompt(): string {
  return `You are writing a brief post-class debrief for a university professor, based ONLY on the lecture transcript and the computed session statistics provided below.

Write 3 short markdown sections:
1. **What was taught** — 2-4 sentences on the topics covered and how the lecture flowed.
2. **How the class engaged** — 2-3 sentences interpreting the provided stats (attendance, participation, quiz/poll results). Quote numbers only from the stats given — never compute or invent your own.
3. **Worth revisiting** — 1-3 bullets: concepts the class struggled with (from the stats) and unanswered student questions worth addressing next session. If there were none, say the class tracked well and omit the bullets.

RULES:
- NEVER invent content, numbers, or student names. Everything must come from the provided transcript and stats.
- The stats arrive as JSON, but you must write plain prose: say "1 of 6 enrolled students attended (17%)" — NEVER echo field names like attendedCount or ratePercent, and never use code formatting.
- Address the professor directly and stay constructive ("the class", "your students").
- Keep the whole narrative under 250 words. No preamble — start with the first heading.

OUTPUT: Markdown only.`
}

// ── Announcement rewrite ("Rewrite with Athena") ────────────────

/**
 * System prompt for polishing a professor's announcement draft. Rewrites the
 * prose for clarity and tone WITHOUT changing the facts — a wrong date or a
 * dropped detail in a course announcement is a real problem, so the rules lean
 * hard on faithfulness over creativity.
 */
export function buildAnnouncementRewritePrompt(): string {
  return `You are Athena, a teaching assistant helping a university professor polish a course announcement they are about to post to students.

Rewrite the announcement below to be clear, warm, and concise, based ONLY on what the professor wrote.

RULES:
1. PRESERVE every fact exactly: dates, times, deadlines, room numbers, names, URLs, and any numbers. Never change, add, or drop a concrete detail.
2. Improve clarity, flow, tone, grammar, and structure only. Do not invent new information or requirements.
3. Keep it roughly the same length or shorter — do not pad.
4. Warm, direct, professional voice addressed to students. No greeting/sign-off unless the professor included one.
5. If the draft is already good, make only light touch-ups.
6. Return ONLY the rewritten announcement text. No preamble like "Here is the rewrite", no explanations, no quotes around it.

OUTPUT: The rewritten announcement as plain text (short paragraphs; a simple bulleted list only if the original had one).`
}
