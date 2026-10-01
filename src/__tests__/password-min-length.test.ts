/**
 * The client's password floor must never be looser than GoTrue's (#726).
 *
 * Three surfaces each hard-coded `< 6` while `supabase/config.toml` had
 * `minimum_password_length = 8`. Nothing was broken in either file on its own —
 * the bug lived in the GAP between them: the form accepted a 7-character password,
 * told the reader it was fine, and then GoTrue rejected it. So the reader got a
 * server error for something the form had already approved, with no hint that the
 * rule they were shown was not the rule being enforced.
 *
 * The constant fixed the drift ONCE. This test is what keeps it fixed, because the
 * failure mode is a change to a file nobody would think to re-run the unit suite
 * for: raise `minimum_password_length` in config.toml and every password form
 * silently goes back to lying. The assertion reads the toml rather than restating
 * `8`, which would only prove the literal is still the literal.
 *
 * Direction matters. The invariant is `client >= server`, not equality: stricter
 * than the server is a form that occasionally asks for more than it must, while
 * looser is a form that promises what the server will refuse. Only the second one
 * is a bug, so only the second one fails here.
 *
 * NOTE — config.toml governs LOCAL dev only. The hosted project's Auth setting is
 * a dashboard value this test cannot see, so a green run here is not proof about
 * production; it only guarantees the two things in the repo agree.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT, passwordProblem } from '@/lib/validations/password'

const CONFIG_PATH = path.resolve(__dirname, '../../supabase/config.toml')

function gotrueMinimum(): number {
  const toml = readFileSync(CONFIG_PATH, 'utf8')
  const match = toml.match(/^\s*minimum_password_length\s*=\s*(\d+)/m)
  /* Failing loudly beats defaulting: if the key is ever renamed or removed, a
     silently-skipped comparison would look identical to a passing one. */
  if (!match) throw new Error('minimum_password_length not found in supabase/config.toml')
  return Number(match[1])
}

describe('PASSWORD_MIN_LENGTH (#726)', () => {
  it('is at least as strict as GoTrue, so the form never promises what the server refuses', () => {
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(gotrueMinimum())
  })

  /* The copy is what the reader is actually held to, so a constant bumped without
     the message being rebuilt from it would show the old number. */
  it('states its own number in the shared copy', () => {
    expect(PASSWORD_TOO_SHORT).toContain(String(PASSWORD_MIN_LENGTH))
  })
})

/**
 * A password of nothing but spaces was accepted everywhere (#729).
 *
 * Eight literal spaces cleared the client's length gate AND GoTrue's own
 * server-side floor, and `updateUser` came back with "Password updated." So the
 * account was left with a password that is both trivially weak and nearly
 * impossible to re-type deliberately — the reader had no way to know what they
 * had just set, and every subsequent sign-in would fail for reasons that look
 * like a platform bug.
 *
 * The design decision worth protecting here is that the password is TESTED for
 * whitespace, never TRIMMED. Trimming would quietly change what the reader typed,
 * and would then disagree with the sign-in path, which deliberately trims only the
 * identifier. A future "helpful" `.trim()` in this function would make
 * '        ' pass as '' or turn a legitimate padded password into a different
 * string that no longer matches what is stored — which is why the third test
 * below exists and would fail on that change.
 */
describe('passwordProblem — whitespace (#729)', () => {
  it('rejects a password of only spaces even when it clears the length floor', () => {
    const allSpaces = ' '.repeat(PASSWORD_MIN_LENGTH)
    expect(allSpaces.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH)
    expect(passwordProblem(allSpaces)).not.toBeNull()
  })

  it.each(['\t\t\t\t\t\t\t\t', '   \n   \n  '])(
    'rejects other whitespace-only forms too (%j)',
    (value) => {
      /* Spaces are what a person types, but a paste can carry tabs or newlines and
         the check is `.trim()` precisely so it covers them rather than just ' '. */
      expect(passwordProblem(value)).not.toBeNull()
    },
  )

  it('accepts a real password with leading and trailing spaces — it tests, it does not trim', () => {
    /* Padding stays MEANINGFUL. This is the assertion that fails if someone adds a
       trim: the returned message would still be null here, but the password the
       reader set would no longer be the password they typed. Asserting acceptance
       pins the intent that only ALL-whitespace is refused. */
    expect(passwordProblem('  correct horse  ')).toBeNull()
  })

  it('reports the length problem first when a password is both too short and blank', () => {
    /* Order is a UX contract, not an accident. '   ' fails both rules; telling
       someone their password is too short is actionable, telling them it "can't be
       only spaces" when it is also too short sends them back for a second round. */
    expect(passwordProblem('   ')).toBe(PASSWORD_TOO_SHORT)
  })

  it('uses the caller\'s label so a confirm/new-password field names itself', () => {
    /* Three surfaces share this function; the copy has to be able to say "New
       password", not always "Password". */
    expect(passwordProblem(' '.repeat(PASSWORD_MIN_LENGTH), 'New password')).toContain('New password')
    expect(passwordProblem('abc', 'New password')).toContain('New password')
  })

  it('passes a normal password', () => {
    expect(passwordProblem('TestStudent123!')).toBeNull()
  })
})
