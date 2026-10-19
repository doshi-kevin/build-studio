/**
 * What a plugin's server code compiles against: the `@scholera/plugin-server` module.
 * Types only. At run time each action receives `ctx`, built by the sandbox from the
 * capabilities the trusted server grants (server-runtime/sandbox-source.ts); nothing of
 * Node, Supabase or Scholera is reachable from it.
 *
 * Pure and import-free: the check worker bundles it.
 */

export const PLUGIN_SERVER_DTS = `
declare module '@scholera/plugin-server' {
  /** A record as server code sees it. No user IDs: mine says whether the caller owns or
   * wrote it, and student is a staff caller's handle for the student an owned record is about. */
  export interface ServerRecord<D = Record<string, unknown>> { id: string; data: D; mine: boolean; student?: string; createdAt: string; updatedAt: string }
  export interface RecordsApi {
    /** One page, newest first. limit 1 to 100. */
    list<D = Record<string, unknown>>(collection: string, options?: { limit?: number; offset?: number }): Promise<ServerRecord<D>[]>
    /** Every record the caller may read in the collection, up to 1000. */
    listAll<D = Record<string, unknown>>(collection: string): Promise<ServerRecord<D>[]>
    get<D = Record<string, unknown>>(collection: string, recordId: string): Promise<ServerRecord<D> | null>
    /** student: the handle a staffPerStudent record is about. */
    create<D = Record<string, unknown>>(collection: string, data: D, options?: { student?: string }): Promise<ServerRecord<D>>
    update<D = Record<string, unknown>>(collection: string, recordId: string, data: D, options?: { expectedUpdatedAt?: string }): Promise<ServerRecord<D>>
    remove(collection: string, recordId: string): Promise<void>
  }
  export interface ActionContext {
    /** Who called. handle is the calling student's stable, anonymous handle in this tool (st_...), null for staff. */
    readonly user: { readonly role: 'student' | 'professor'; readonly handle: string | null }
    readonly records: RecordsApi
    readonly course: { get(): Promise<{ code: string; title: string }> }
    /** An analytics event: a camelCase name and up to 8 short values. At most 5 per call. */
    readonly log: { event(name: string, data?: Record<string, string | number | boolean>): void }
    /** A deterministic random number generator in [0, 1): the same seed always gives the same sequence. */
    random(seed: string): () => number
    /** The current time, ISO 8601. */
    now(): string
  }
  /** One server action: (ctx, args) to a JSON-serializable result. */
  export type Action<A = Record<string, unknown>, R = unknown> = (ctx: ActionContext, args: A) => R | Promise<R>
}
`
