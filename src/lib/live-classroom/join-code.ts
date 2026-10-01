// The attendance join code a professor shows on the projector (#82).
//
// Two rules shape everything here:
//
//  1. It is read off a screen at the back of a lecture hall, and often said aloud. So it is
//     short, and the alphabet has no glyph pairs that look or sound alike.
//  2. Uniqueness is NOT a property of this generator. Randomness proposes; the unique index
//     idx_lc_room_codes_code disposes, and startLiveClass rolls again when it loses. Anything
//     that depends on "a collision is unlikely" eventually marks the wrong class present.
//     The code deliberately does NOT live on lc_rooms: students can read their own section's
//     room row, so a column there would hand them the code that gates them.

/**
 * 31 characters. Removed for looking alike on a projector: O/0, I/1/L.
 * Kept: everything else, including S/5 and B/8, which are distinguishable in the display face
 * and unambiguous when spoken.
 */
export const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

export const JOIN_CODE_LENGTH = 4

/**
 * How many times to re-roll when the database rejects a candidate as already in use by
 * another LIVE room. With 923,521 codes and a realistic number of concurrent sessions, a
 * single collision is already improbable; five in a row is not something to keep retrying
 * past, it is a signal that something is wrong.
 */
export const JOIN_CODE_MAX_ATTEMPTS = 5

/**
 * A candidate code. Uses crypto rather than Math.random: this is a credential, however
 * short-lived, and Math.random is seeded predictably enough that a motivated student could
 * narrow the space if they knew when a session started.
 *
 * Rejection-sampled rather than taking `% alphabet.length`, which would bias the first two
 * characters of the alphabet upward and shrink the effective space.
 */
export function generateJoinCode(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  const n = JOIN_CODE_ALPHABET.length
  // The largest multiple of n that fits in a byte; values at or above it are discarded so
  // every character is equally likely.
  const limit = Math.floor(256 / n) * n
  let out = ''
  while (out.length < JOIN_CODE_LENGTH) {
    for (const byte of randomBytes(JOIN_CODE_LENGTH)) {
      if (byte >= limit) continue
      out += JOIN_CODE_ALPHABET[byte % n]
      if (out.length === JOIN_CODE_LENGTH) break
    }
  }
  return out
}

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/**
 * What a student typed, in the form the stored code is in.
 *
 * Lower case and whitespace are the two things people reliably get "wrong" while being
 * completely right, so they are normalised rather than rejected. Nothing else is: a code with
 * a stray letter is a wrong code, and quietly stripping characters would let a near-miss
 * through.
 */
export function normalizeJoinCode(input: string): string {
  return input.trim().replace(/\s+/g, '').toUpperCase()
}

/** Whether a submitted code is even shaped like one, before spending a database round trip. */
export function isWellFormedJoinCode(input: string): boolean {
  const c = normalizeJoinCode(input)
  if (c.length !== JOIN_CODE_LENGTH) return false
  return [...c].every((ch) => JOIN_CODE_ALPHABET.includes(ch))
}
