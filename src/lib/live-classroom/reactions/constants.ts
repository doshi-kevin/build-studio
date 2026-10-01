// How long a single reaction counts toward the professor's live badge before it
// decays out (#36). Shared so the student button's "visible to prof" drain and
// the professor's aggregation window can never drift apart.
export const REACTION_VISIBLE_MS = 8000
