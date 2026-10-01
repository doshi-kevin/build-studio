// render_scheduled_deck — background pipeline that renders a scheduled session's
// pre-uploaded deck without a browser. Enqueued by scheduleLiveClass right after
// the professor's file lands in storage, so the professor can leave immediately
// and the slides are ready well before class. Never activates the deck on the
// room — the professor still clicks "Start class" (attended model).

import 'server-only'

import type { BackgroundPipeline, PipelineContext } from '../types'
import { renderDeckToStorage, RenderDeckError } from '@/lib/live-classroom/render-deck'
import { logger } from '@/lib/logger'

export const renderScheduledDeckPipeline: BackgroundPipeline = {
  type: 'render_scheduled_deck',
  async run(params, ctx: PipelineContext) {
    const roomId = String(params.roomId ?? '')
    const deckId = String(params.deckId ?? '')
    const sectionId = ctx.job.section_id
    if (!roomId || !deckId) throw new Error('render_scheduled_deck: roomId and deckId are required')
    if (!sectionId) throw new Error('render_scheduled_deck: job has no section_id')

    const db = ctx.adminDb

    // Idempotency: a lost/re-kicked job must not re-render. If the deck already
    // has a deck_url it's done.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: deck } = await (db as any)
      .from('lc_decks')
      .select('id, deck_url')
      .eq('id', deckId)
      .eq('room_id', roomId)
      .maybeSingle()
    if (!deck) {
      // Room/deck cancelled before the worker got to it — nothing to do.
      return { result: { skipped: 'deck_gone' }, summary: 'Deck no longer exists' }
    }
    if (deck.deck_url) {
      return { result: { skipped: 'already_rendered' }, summary: 'Deck already rendered' }
    }

    try {
      const { pageCount } = await renderDeckToStorage({
        adminDb: db,
        roomId,
        deckId,
        activate: false,
        userId: ctx.job.created_by,
        sectionId,
      })
      return { result: { pageCount }, summary: `Rendered ${pageCount} slides` }
    } catch (err) {
      if (err instanceof RenderDeckError && err.reason === 'cancelled') {
        // The session was cancelled mid-render — a clean no-op, not a failure.
        logger.info('render_scheduled_deck: cancelled mid-render', { roomId, deckId })
        return { result: { skipped: 'cancelled' }, summary: 'Session cancelled' }
      }
      // Genuine render failure: drop the half-baked deck row so reopening the
      // session offers a clean re-upload (not a stuck "Preparing…"). The failed
      // job row remains, so the Upcoming list still badges this session
      // "Slides failed". Orphaned storage is swept by the daily deck reaper.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from('lc_decks').delete().eq('id', deckId).eq('room_id', roomId)
      throw err
    }
  },
}
