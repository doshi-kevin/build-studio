/**
 * The live eval's environment guard. The eval needs one secret, the model key, and no
 * database: a Supabase secret in its environment means an env file leaked in, which on a
 * developer machine can be production's.
 */
export const SUPABASE_SECRETS = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DATABASE_PASSWORD', 'SUPABASE_DB_URL', 'SUPABASE_MGMT_TOKEN'] as const

/** The Supabase secrets present in an environment, by name. Empty strings count as absent. */
export function leakedSecrets(env: Record<string, string | undefined>): string[] {
  return SUPABASE_SECRETS.filter((name) => (env[name] ?? '') !== '')
}
