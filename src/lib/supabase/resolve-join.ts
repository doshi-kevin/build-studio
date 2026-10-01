/**
 * Supabase embedded-select joins return a single relation as either an object or a
 * single-element array depending on context. This helper normalises both to a scalar.
 * Typed generically so call-sites preserve the relation's inferred type.
 */
export const resolveJoin = <T,>(val: T | T[]): T => (Array.isArray(val) ? val[0] : val)
