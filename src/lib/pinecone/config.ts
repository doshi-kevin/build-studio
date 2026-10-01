import 'server-only'

// Pinned configuration for the materials vector store. One embedding model +
// dimension per index — a mixed-model index corrupts retrieval with zero
// errors, so changing ANY of these is a blue/green re-index into a NEW index
// behind the env var, never an in-place change (.claude/rules/vector-db.md §9).

/** Google's first natively multimodal embedder — text + page image → one vector. */
export const EMBEDDING_MODEL = 'gemini-embedding-2'
export const EMBEDDING_DIM = 3072

/** Gemini tokenizes each image at a fixed count, billed at the model's image
 * rate ($0.45/MTok vs $0.20 text) — used to split a page's usageMetadata total
 * into text vs image shares for the cost ledger. */
export const EMBEDDING_IMAGE_TOKENS = 258

/** Segmentation scheme stamped on every vector: one PDF page = one vector. */
export const CHUNKER_VERSION = 'page-v1'

/** Professor-authored course material (the FERPA-safe class). */
export const CONTENT_CLASS_COURSE_MATERIAL = 'course_material'

/** The professor's own spoken words from an ended live class (N1) — the second
 * allowlisted class, sign-off recorded in athena-students.md §9 (professor
 * speech, inside the FERPA-safe class; nothing student-generated is ever
 * embedded). Erasure path ships alongside: `deleteTranscriptVectors` (deck- or
 * room-prefixed), wired where transcript source rows are erased. */
export const CONTENT_CLASS_LECTURE_TRANSCRIPT = 'lecture_transcript'

/** Segmentation scheme for transcript vectors: one (deck, slide)'s spoken text
 * = one vector — the natural unit, since `lc_transcriptions` is keyed that way
 * and the citation a student sees is "slide N (spoken)". */
export const TRANSCRIPT_CHUNKER_VERSION = 'slide-v1'

/** Spoken-text rows below this many words are skipped at ingestion: a two-word
 * aside embeds as noise that outranks nothing and pollutes topK. */
export const TRANSCRIPT_MIN_WORDS = 20
/** Content class for rubric reference answers (professor-authored, one vector per criterion). */
export const CONTENT_CLASS_RUBRIC_REFERENCE = 'rubric_reference'

/** Chunker version for rubric reference vectors — one criterion = one vector. */
export const RUBRIC_CHUNKER_VERSION = 'criterion-v1'

export const METADATA_SCHEMA_VERSION = 1

/**
 * Retrieval score floor for the `student-qa-v1` profile: a retrieved page whose
 * cosine score is below this is treated as not-relevant. When NO page clears it,
 * the tutor takes the honest "insufficient context" branch (refuses instead of
 * grounding on the nearest-but-irrelevant pages) — design doc §3/§4, guardrails
 * G1/G2. Calibrated on the seeded CS584 index (in-corpus tops 0.59–0.72,
 * out-of-corpus tops 0.49–0.53), then RAISED 0.55 → 0.58 on eval evidence: at
 * 0.55 the out-of-corpus "alpha-beta pruning" question topped out at 0.569 and
 * was answered instead of refused, and 0.58 removed that with zero movement in
 * any answer-side metric (0.62 broke a case, so the safe band is narrow).
 *
 * This is the DENSE floor. It applies when the reranker is off or has fallen
 * back to dense order; the reranked path has its own — see
 * `STUDENT_QA_PROFILE.rerankScoreFloor`, since a cross-encoder score is not a
 * cosine and the two thresholds are not interchangeable.
 */
export const STUDENT_QA_SCORE_FLOOR = 0.58

/**
 * The `student-qa-v1` retrieval profile — every knob the student Q&A path runs
 * on, in ONE place so the eval gate (`eval/retrieval/`) measures what
 * production actually does (vector-db rule 12: no inline retrieval literals).
 * Changing a value here is a retrieval-knob change: run the gate and commit the
 * new baseline in the same PR.
 */
export const STUDENT_QA_PROFILE = {
  name: 'student-qa-v1',
  /**
   * Candidate pool pulled from Pinecone when the cross-encoder is available.
   * Wide because the reranker, not the dense score, then decides what reaches
   * the prompt — the eval measured the right page inside the top 40 on 94% of
   * questions but inside the dense top 8 on only 76%, and that gap is what a
   * wide pool plus a reranker recovers.
   *
   * A wide pool is only safe WITH the reranker: unranked, it would put 40 pages
   * in the prompt instead of 8 — 5× the context tokens and measurably worse
   * precision (0.64 → 0.59 on the golden set). Use `studentQaTopK()`, never
   * this field directly.
   */
  topK: 40,
  /** Pool when the reranker is unavailable — the dense order IS the answer, so
   *  the pool and the prompt are the same list. */
  denseTopK: 8,
  /**
   * Pages that survive reranking and reach the prompt.
   *
   * Chosen by sweep, not by taste. Against the dense top-8 baseline, rerank
   * top-6 trades recall for precision (0.816 → 0.762 recall, 0.703 → 0.797
   * precision) and top-8 still sits below dense on recall; **top-10 is the only
   * width that beats the dense path on every metric at once** — recall 0.851,
   * MRR 0.828, precision 0.783, gold-found tied at 0.964. Two extra pages of
   * prompt buys a strictly better context, so the eval picks 10 over the design
   * doc's original "~6".
   */
  rerankTopN: 10,
  /** Google's hosted cross-encoder (Vertex AI Ranking API). Authenticates with
   *  the same credentials the app deploys under — no key, no new vendor. */
  rerankModel: 'semantic-ranker-default-004',
  /**
   * Per-document text sent to the reranker. `semantic-ranker-default-004` reads
   * 1,024 tokens per record; slide text is token-dense (formulas, symbols), so
   * this cap keeps a page comfortably inside that rather than relying on the
   * service to cut it somewhere we didn't choose.
   */
  rerankMaxDocChars: 2_500,
  /**
   * Relevance floor on the RERANKED score. A cross-encoder score is not a
   * cosine — it is a calibrated relevance probability with a far wider spread —
   * so it needs its own threshold rather than the dense one below.
   *
   * Calibrated on the golden eval against this ranker's own score distribution,
   * which separates far more cleanly than cosine does: out-of-corpus questions
   * top out at 0.079 while the weakest in-corpus question reaches 0.185, so
   * 0.12 is the geometric midpoint of a 2.4× gap and anything in 0.10–0.15
   * scores identically. (The dense floor had no such gap — 0.569 out-of-corpus
   * against in-corpus starting at 0.59, which is why it needed 0.58 exactly.)
   * It is the G1/G2 honest-refusal guardrail on this path, so re-calibrate with
   * `npm run eval:retrieval -- --floor=…` if the ranker model changes.
   */
  rerankScoreFloor: 0.12,
  /**
   * Dense-cosine floor. Still live on two paths: when the reranker is off, and
   * when the circuit-breaker falls back to dense order after a rerank failure.
   */
  scoreFloor: STUDENT_QA_SCORE_FLOOR,
  /** The wide-pool depth the eval reports Recall@40 on. */
  evalPoolTopK: 40,
} as const

/**
 * Is the hosted reranker turned on for this environment?
 *
 * **On by default; opt OUT with `RERANK_ENABLED=0`.** It measurably beats dense
 * retrieval on every metric of the golden eval, so the better answer is the
 * default and the switch exists to turn it off — for a cost freeze, a vendor
 * incident, or an environment without the Discovery Engine grant.
 *
 * It is still a real switch, because it decides three things at once: the spend
 * ($1 per 1,000 messages), the pool width (`studentQaTopK()`), and whether page
 * text leaves for a second Google service. It also gates query decomposition,
 * which is unsafe without a cross-encoder to re-score sub-query results.
 *
 * Being default-on puts the weight on failing well: an environment missing the
 * IAM grant would otherwise pay a doomed round trip on every single message, so
 * `rerankPooled` carries a circuit breaker that stops calling after a few
 * consecutive failures. That is the lesson from the Pinecone attempt, where the
 * entitlement was 0 and every call failed silently.
 */
export function isRerankEnabled(): boolean {
  return process.env.RERANK_ENABLED !== '0' && process.env.RERANK_ENABLED?.toLowerCase() !== 'false'
}

/**
 * How deep to pull from Pinecone for a student question.
 *
 * The pool width and the reranker are ONE decision, not two: 40 candidates are
 * a candidate pool when something ranks them and a 40-page prompt when nothing
 * does. Deriving it from the entitlement keeps the two from drifting apart the
 * moment the plan changes in either direction.
 */
export function studentQaTopK(): number {
  return isRerankEnabled() ? STUDENT_QA_PROFILE.topK : STUDENT_QA_PROFILE.denseTopK
}
