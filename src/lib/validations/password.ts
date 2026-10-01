/**
 * The one password floor for every surface that sets or changes a password.
 *
 * Three client surfaces each hard-coded `< 6` while `supabase/config.toml` sets
 * `minimum_password_length = 8` (#726). The client is what the user sees, so a
 * 6-or-7-character password passed validation here and was then rejected by
 * GoTrue — the reader gets a server error for something the form told them was
 * fine. Aligned UP to the stricter committed value rather than down: being
 * stricter than the server is safe, the reverse is a broken form.
 *
 * Keep this in lockstep with `minimum_password_length` in `supabase/config.toml`
 * AND with the hosted project's Auth setting — config.toml governs local dev
 * only, so the production value has to be confirmed in the dashboard.
 */
export const PASSWORD_MIN_LENGTH = 8

/** Shared copy so all three surfaces phrase the same rule the same way. */
export const PASSWORD_TOO_SHORT = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`

/**
 * Same rule, naming the field. Change-password has three password inputs, so a
 * bare "Password must be…" leaves the reader guessing which one it means.
 */
export const passwordTooShort = (label: string) =>
  `${label} must be at least ${PASSWORD_MIN_LENGTH} characters`

/**
 * The one place a password is judged. Returns the message to show, or null if it
 * passes.
 *
 * Length was already shared; whitespace was not checked anywhere (#729). Eight
 * literal spaces passed both the client's length gate and GoTrue's own server-side
 * floor, and `updateUser` reported "Password updated." — leaving the account with a
 * password that is trivially weak and almost impossible to type deliberately.
 *
 * The password is NOT trimmed before comparison, only tested. Trimming here would
 * silently change what the user typed, and would then disagree with the sign-in path,
 * which deliberately does not trim the password (only the identifier). Rejecting is
 * the honest behaviour: leading or trailing spaces stay meaningful, an all-whitespace
 * password is refused.
 */
export function passwordProblem(password: string, label = 'Password'): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return label === 'Password' ? PASSWORD_TOO_SHORT : passwordTooShort(label)
  }
  if (password.trim().length === 0) return `${label} can't be only spaces`
  return null
}
