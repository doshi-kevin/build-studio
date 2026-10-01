// The retrieval result shape, split out from search.ts so the pure rerank logic
// can type against it without importing the module that imports IT back.
// `search.ts` re-exports this, so every existing import site is unchanged.

export interface MaterialPageResult {
  /** For a spoken result this is the deck's promoted material (when it has
   *  one — that's what makes the citation chip previewable), else ''. */
  moduleItemId: string
  moduleId: string
  /** 1-based for BOTH classes — the number a student sees and cites (a spoken
   *  slide's 0-based lc_transcriptions.page_number is shifted here). */
  pageNumber: number
  /**
   * Relevance. Dense cosine normally; the cross-encoder's relevance score when
   * `reranked` is true. The two scales are NOT comparable — use
   * `clearsRelevanceFloor()` rather than comparing to a floor by hand.
   */
  score: number
  /** Module item title — for "Lecture 5, p.14"-style citations. For a spoken
   *  result, the deck title (falling back to the room name). */
  title: string
  breadcrumb: string
  /** Full page text, hydrated from Postgres (never stored in Pinecone). */
  text: string
  /** True when this is the professor's spoken words (content class
   *  lecture_transcript, N1) — cited as "[Title (spoken), slide N]". */
  spoken?: boolean
  /** True when `score` came from the cross-encoder. Absent means the dense
   *  order stands — either reranking was off, or it failed and the
   *  circuit-breaker fell back. */
  reranked?: boolean
}
